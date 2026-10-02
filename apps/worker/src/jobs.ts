import { CHECK_RETENTION_DAYS, LimitExceededError, webhookPayload, type PrCheckJobData } from '@deployhealth/core';
import type { CheckOutcome, DueEndpoint, NewPrCheck, PrCheck, PrCheckTarget, RecordCheckResult } from '@deployhealth/db';
import type { CheckResult, CheckTarget } from './check';
import type { GithubApi } from './github/api';
import { detectAgent } from './pr-check/agents';
import { buildReport } from './pr-check/build';
import { UncheckableError, type PrCheckIsolate } from './pr-check/isolate';
import {
  checkRunOutput,
  COMMENT_MARKER,
  conclusionFor,
  emptyReport,
  renderComment,
  totals,
  uncheckableOutput,
  worthCommenting,
  type PrReport,
} from './pr-check/report';

export const CHECK_QUEUE = 'check-endpoints';
export const PRUNE_QUEUE = 'prune-checks';
export const RESEED_QUEUE = 'reseed-demo';
export { PR_CHECK_QUEUE } from '@deployhealth/core';

export interface CheckEndpointsDeps {
  claimDue: () => Promise<DueEndpoint[]>;
  check: (target: CheckTarget) => Promise<CheckResult>;
  record: (endpointId: string, outcome: CheckOutcome) => Promise<RecordCheckResult>;
  notify: (webhookUrl: string, payload: { text: string }) => Promise<boolean>;
  /** Marks the worker alive (worker_heartbeats), at the end of every run, even with nothing due. */
  heartbeat: () => Promise<void>;
  log: (message: string) => void;
  /** Checks run in parallel, up to this many at a time. */
  concurrency?: number;
  /** Resolves at `until` (or at once if it has passed). Tests pass a fake clock. */
  sleepUntil?: (until: Date) => Promise<void>;
}

const realSleepUntil = (until: Date) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, until.getTime() - Date.now())));

export interface CheckEndpointsSummary {
  checked: number;
  failed: number;
  opened: number;
  resolved: number;
  errors: number;
}

/**
 * The `check-endpoints` job (every minute): claim due endpoints, check them, record each result
 * (which may open or resolve an alert) and send webhooks for alert events. One endpoint's error
 * never stops the others.
 *
 * Each claimed endpoint has a start time (`runAt`) that keeps checks of one hostname at least
 * 10 seconds apart across all users. Endpoints sharing a start time form a wave; waves run in
 * order, each no earlier than its start time (never early, so the spacing only ever grows).
 * Alert webhooks are sent alongside, outside the concurrency limit, so a slow webhook never
 * delays a check; the run waits for them before it records the heartbeat /api/health/worker reads.
 */
export async function checkEndpoints(deps: CheckEndpointsDeps): Promise<CheckEndpointsSummary> {
  const due = await deps.claimDue();
  const summary: CheckEndpointsSummary = { checked: 0, failed: 0, opened: 0, resolved: 0, errors: 0 };
  const sleepUntil = deps.sleepUntil ?? realSleepUntil;

  const waves = new Map<number, DueEndpoint[]>();
  for (const endpoint of due) {
    const wave = waves.get(endpoint.runAt.getTime());
    if (wave) wave.push(endpoint);
    else waves.set(endpoint.runAt.getTime(), [endpoint]);
  }
  // Webhooks start as soon as their check is recorded but never hold one of the check slots.
  const sends: Array<Promise<unknown>> = [];
  for (const at of [...waves.keys()].sort((a, b) => a - b)) {
    await sleepUntil(new Date(at));
    await forEachLimited(waves.get(at)!, deps.concurrency ?? 10, (endpoint) => checkOne(endpoint, deps, summary, sends));
  }
  await Promise.allSettled(sends);
  // A claim that throws skips this, so the deep health check sees a worker that can't do its job.
  // A failed write is logged, not thrown: the run itself succeeded.
  try {
    await deps.heartbeat();
  } catch (error) {
    deps.log(`[check] heartbeat not recorded: ${(error as Error).name}`);
  }
  return summary;
}

/** Check one endpoint, record the result, and start the webhook for an alert event, if any (into `sends`). */
async function checkOne(endpoint: DueEndpoint, deps: CheckEndpointsDeps, summary: CheckEndpointsSummary, sends: Array<Promise<unknown>>): Promise<void> {
  try {
    const outcome = await deps.check(endpoint);
    const { event } = await deps.record(endpoint.id, outcome);
    summary.checked++;
    if (!outcome.ok) summary.failed++;
    if (!event) return;
    summary[event.type === 'opened' ? 'opened' : 'resolved']++;
    deps.log(`[alert] ${event.type}: ${event.projectName}: ${event.message}`);
    if (event.webhookUrl) sends.push(deps.notify(event.webhookUrl, webhookPayload(event.type, event.projectName, event.message)).catch(() => false));
  } catch (error) {
    summary.errors++;
    // The host only, and the error's name and code: never the URL (its path or query may hold a
    // token) or a message that could quote it.
    deps.log(`[check] ${endpoint.hostname} could not be processed: ${errorLabel(error)}`);
  }
}

/** An error's name, plus its code when it has a string one (`ECONNRESET`, a Postgres SQLSTATE). */
export function errorLabel(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? `${name} ${code}` : name;
}

/** The nightly `prune-checks` job: delete checks older than the retention window. */
/**
 * Nightly: first roll every complete UTC day up into daily stats (monthly reports read those),
 * then delete raw checks from whole days more than 30 days back. If the rollup fails, nothing is
 * deleted, so no day is ever lost.
 */
export async function pruneOldChecks(deps: {
  rollup: (before: Date) => Promise<number>;
  prune: (olderThan: Date) => Promise<number>;
  /** GitHub webhook delivery ids, kept 24 h for dedupe. */
  pruneDeliveries?: (olderThan: Date) => Promise<number>;
  now?: () => Date;
  log: (message: string) => void;
}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rolled = await deps.rollup(new Date(today));
  const cutoff = new Date(today - CHECK_RETENTION_DAYS * 24 * 3_600_000);
  const deleted = await deps.prune(cutoff);
  const deliveries = (await deps.pruneDeliveries?.(new Date(now.getTime() - 24 * 3_600_000))) ?? 0;
  deps.log(`[prune] rolled up ${rolled} endpoint-days; deleted ${deleted} checks before ${cutoff.toISOString()} and ${deliveries} webhook deliveries`);
  return deleted;
}

async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

/**
 * Restore the public demo to its seed state (one transaction; see seed() in @deployhealth/db).
 * Runs nightly and once when the worker starts, so production needs no manual seed step. The
 * seed's ingest token is never logged: nobody should be able to post scans to the demo.
 */
export async function reseedDemo(deps: { seed: (now: Date) => Promise<unknown>; now?: () => Date; log: (message: string) => void }): Promise<void> {
  const started = Date.now();
  await deps.seed(deps.now?.() ?? new Date());
  deps.log(`[reseed-demo] demo data restored in ${Date.now() - started}ms`);
}

// ---------------------------------------------------------------------------------------------
// pr-check: the GitHub App's env check on a pull request
// ---------------------------------------------------------------------------------------------

export interface PrCheckDeps {
  findTarget: (installationId: number, repoFullName: string) => Promise<PrCheckTarget | null>;
  findCommentId: (projectId: string, prNumber: number) => Promise<number | null>;
  saveCheck: (row: Omit<NewPrCheck, 'id' | 'createdAt' | 'updatedAt' | 'closedAt'>) => Promise<PrCheck>;
  setGithubIds: (id: string, ids: { commentId: number | null; checkRunId: number | null }) => Promise<void>;
  /** GitHub calls for one repository, as the installation. */
  api: (installationId: number, repoFullName: string) => GithubApi;
  log: (message: string) => void;
  /** Starts the isolate for the CPU work; the default is the real one (tests shorten its limit). */
  openIsolate?: () => Promise<PrCheckIsolate>;
}

export type PrCheckOutcome = 'no-project' | 'off' | 'closed' | PrCheck['conclusion'];

const status = (error: unknown) => (error as { status?: number }).status;

/**
 * Check one pull request: find the project (the installation's linked user's, for this repo),
 * skip everything in `off` mode, read the pull request's current head and its merge base, build
 * the report within the hard caps, store it (one row per head), then update the one comment
 * (found by id, else by its hidden marker; created only when there's something to say) and the
 * `deployhealth / env` check run for that head. Running a head twice updates both in place.
 */
export async function prCheck(job: PrCheckJobData, deps: PrCheckDeps): Promise<PrCheckOutcome> {
  const where = `${job.repoFullName}#${job.prNumber}`;
  const target = await deps.findTarget(job.installationId, job.repoFullName);
  if (!target) {
    deps.log(`[pr-check] ${where}: no linked project for this repo; nothing stored`);
    return 'no-project';
  }
  const mode = target.project.prCheckMode;
  if (mode === 'off') return 'off';

  const api = deps.api(job.installationId, job.repoFullName);
  const pr = await api.pullRequest(job.prNumber);
  if (pr.state !== 'open') return 'closed';

  let report: PrReport;
  try {
    report = await buildReport(api, pr, { openIsolate: deps.openIsolate });
  } catch (error) {
    if (error instanceof UncheckableError) return reportUncheckable(job, pr, target, deps, api, error);
    if (!(error instanceof LimitExceededError)) throw error;
    report = emptyReport(error.message);
  }
  const agent = detectAgent(pr.authorLogin, await api.commitMessages(pr.number));
  const conclusion = conclusionFor(report, mode);

  const row = await deps.saveCheck({
    projectId: target.project.id,
    installationId: target.installationId,
    prNumber: pr.number,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    authorLogin: pr.authorLogin,
    authorIsAgent: agent.isAgent,
    agentName: agent.name,
    addedVars: report.added,
    removedVars: report.removed,
    renamedVars: report.renamed,
    undeclaredVars: report.undeclared,
    committedEnvFiles: report.envFiles,
    secretHits: totals(report).secrets,
    conclusion,
  });

  // The one comment on this pull request.
  const body = renderComment(report, { mode, headSha: pr.headSha });
  let commentId = row.commentId ?? (await deps.findCommentId(target.project.id, pr.number)) ?? (await api.findMarkedComment(pr.number, COMMENT_MARKER));
  if (commentId !== null) {
    try {
      await api.updateComment(commentId, body);
    } catch (error) {
      if (status(error) !== 404) throw error;
      commentId = null; // deleted by someone: post a fresh one if there's something to say
    }
  }
  if (commentId === null && worthCommenting(report)) commentId = await api.createComment(pr.number, body);

  // The check run for this head.
  const output = checkRunOutput(report, conclusion);
  let checkRunId = row.checkRunId;
  if (checkRunId !== null) {
    try {
      await api.updateCheckRun(checkRunId, output);
    } catch (error) {
      if (status(error) !== 404) throw error;
      checkRunId = null;
    }
  }
  checkRunId ??= await api.createCheckRun(pr.headSha, output);

  await deps.setGithubIds(row.id, { commentId, checkRunId });
  const n = totals(report);
  deps.log(
    `[pr-check] ${where} ${pr.headSha.slice(0, 7)}: ${conclusion}${report.outcome && report.outcome !== 'checked' ? ` ${report.outcome}` : ''} (+${n.added} -${n.removed} ~${n.renamed}, ` +
      `${n.undeclared} undeclared, ${n.envFiles} env files, ${n.secrets} possible secrets${agent.name ? `, agent ${agent.name}` : ''})`,
  );
  return conclusion;
}

/**
 * The isolate couldn't finish this pull request (time limit, a scanner error, out of memory): the
 * input is the cause, so running it again would fail the same way. Store a neutral row, report a
 * neutral check run with a fixed message, leave the comment alone, and return normally so pg-boss
 * doesn't retry. GitHub and database errors still throw (and retry).
 */
async function reportUncheckable(
  job: PrCheckJobData,
  pr: Awaited<ReturnType<GithubApi['pullRequest']>>,
  target: PrCheckTarget,
  deps: PrCheckDeps,
  api: GithubApi,
  error: UncheckableError,
): Promise<PrCheckOutcome> {
  const agent = detectAgent(pr.authorLogin, await api.commitMessages(pr.number));
  const empty = emptyReport();
  const row = await deps.saveCheck({
    projectId: target.project.id,
    installationId: target.installationId,
    prNumber: pr.number,
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    authorLogin: pr.authorLogin,
    authorIsAgent: agent.isAgent,
    agentName: agent.name,
    addedVars: empty.added,
    removedVars: empty.removed,
    renamedVars: empty.renamed,
    undeclaredVars: empty.undeclared,
    committedEnvFiles: empty.envFiles,
    secretHits: 0,
    conclusion: 'neutral',
  });
  let checkRunId = row.checkRunId;
  if (checkRunId !== null) {
    try {
      await api.updateCheckRun(checkRunId, uncheckableOutput());
    } catch (updateError) {
      if (status(updateError) !== 404) throw updateError;
      checkRunId = null;
    }
  }
  checkRunId ??= await api.createCheckRun(pr.headSha, uncheckableOutput());
  await deps.setGithubIds(row.id, { commentId: row.commentId, checkRunId });
  deps.log(`[pr-check] ${job.repoFullName}#${job.prNumber} ${pr.headSha.slice(0, 7)}: couldn't be checked (${error.reason}); not retried`);
  return 'neutral';
}

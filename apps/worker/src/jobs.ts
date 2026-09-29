import { CHECK_RETENTION_DAYS, LimitExceededError, webhookPayload, type PrCheckJobData } from '@deployhealth/core';
import type { CheckOutcome, DueEndpoint, NewPrCheck, PrCheck, PrCheckTarget, RecordCheckResult } from '@deployhealth/db';
import type { CheckResult, CheckTarget } from './check';
import type { GithubApi } from './github/api';
import { detectAgent } from './pr-check/agents';
import { buildReport } from './pr-check/build';
import { checkRunOutput, COMMENT_MARKER, conclusionFor, emptyReport, renderComment, worthCommenting, type PrReport } from './pr-check/report';

export const CHECK_QUEUE = 'check-endpoints';
export const PRUNE_QUEUE = 'prune-checks';
export const RESEED_QUEUE = 'reseed-demo';
export { PR_CHECK_QUEUE } from '@deployhealth/core';

export interface CheckEndpointsDeps {
  claimDue: () => Promise<DueEndpoint[]>;
  check: (target: CheckTarget) => Promise<CheckResult>;
  record: (endpointId: string, outcome: CheckOutcome) => Promise<RecordCheckResult>;
  notify: (webhookUrl: string, payload: { text: string }) => Promise<boolean>;
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
 */
export async function checkEndpoints(deps: CheckEndpointsDeps): Promise<CheckEndpointsSummary> {
  const due = await deps.claimDue();
  const summary: CheckEndpointsSummary = { checked: 0, failed: 0, opened: 0, resolved: 0, errors: 0 };
  const sleepUntil = deps.sleepUntil ?? realSleepUntil;

  const waves = new Map<number, DueEndpoint[]>();
  for (const endpoint of due) waves.set(endpoint.runAt.getTime(), [...(waves.get(endpoint.runAt.getTime()) ?? []), endpoint]);
  for (const at of [...waves.keys()].sort((a, b) => a - b)) {
    await sleepUntil(new Date(at));
    await forEachLimited(waves.get(at)!, deps.concurrency ?? 10, (endpoint) => checkOne(endpoint, deps, summary));
  }
  return summary;
}

/** Check one endpoint, record the result, and send the webhook for an alert event, if any. */
async function checkOne(endpoint: DueEndpoint, deps: CheckEndpointsDeps, summary: CheckEndpointsSummary): Promise<void> {
  try {
    const outcome = await deps.check(endpoint);
    const { event } = await deps.record(endpoint.id, outcome);
    summary.checked++;
    if (!outcome.ok) summary.failed++;
    if (!event) return;
    summary[event.type === 'opened' ? 'opened' : 'resolved']++;
    deps.log(`[alert] ${event.type}: ${event.projectName}: ${event.message}`);
    if (event.webhookUrl) await deps.notify(event.webhookUrl, webhookPayload(event.type, event.projectName, event.message));
  } catch (error) {
    summary.errors++;
    deps.log(`[check] ${endpoint.url} could not be processed: ${(error as Error).message}`);
  }
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
    report = await buildReport(api, pr);
  } catch (error) {
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
    secretHits: report.secrets.length,
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
  deps.log(
    `[pr-check] ${where} ${pr.headSha.slice(0, 7)}: ${conclusion} (+${report.added.length} -${report.removed.length} ~${report.renamed.length}, ` +
      `${report.undeclared.length} undeclared, ${report.envFiles.length} env files, ${report.secrets.length} possible secrets${agent.name ? `, agent ${agent.name}` : ''})`,
  );
  return conclusion;
}

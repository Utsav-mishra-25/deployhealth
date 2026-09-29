import { CHECK_RETENTION_DAYS, webhookPayload } from '@deployhealth/core';
import type { CheckOutcome, DueEndpoint, RecordCheckResult } from '@deployhealth/db';
import type { CheckResult, CheckTarget } from './check';

export const CHECK_QUEUE = 'check-endpoints';
export const PRUNE_QUEUE = 'prune-checks';
export const RESEED_QUEUE = 'reseed-demo';

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
  now?: () => Date;
  log: (message: string) => void;
}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rolled = await deps.rollup(new Date(today));
  const cutoff = new Date(today - CHECK_RETENTION_DAYS * 24 * 3_600_000);
  const deleted = await deps.prune(cutoff);
  deps.log(`[prune] rolled up ${rolled} endpoint-days; deleted ${deleted} checks before ${cutoff.toISOString()}`);
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

import { CHECK_RETENTION_DAYS, webhookPayload } from '@deployhealth/core';
import type { CheckOutcome, DueEndpoint, RecordCheckResult } from '@deployhealth/db';
import type { CheckResult, CheckTarget } from './check';

export const CHECK_QUEUE = 'check-endpoints';
export const PRUNE_QUEUE = 'prune-checks';

export interface CheckEndpointsDeps {
  claimDue: () => Promise<DueEndpoint[]>;
  check: (target: CheckTarget) => Promise<CheckResult>;
  record: (endpointId: string, outcome: CheckOutcome) => Promise<RecordCheckResult>;
  notify: (webhookUrl: string, payload: { text: string }) => Promise<boolean>;
  log: (message: string) => void;
  /** Checks run in parallel, up to this many at a time. */
  concurrency?: number;
}

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
 */
export async function checkEndpoints(deps: CheckEndpointsDeps): Promise<CheckEndpointsSummary> {
  const due = await deps.claimDue();
  const summary: CheckEndpointsSummary = { checked: 0, failed: 0, opened: 0, resolved: 0, errors: 0 };

  await forEachLimited(due, deps.concurrency ?? 10, async (endpoint) => {
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
  });

  return summary;
}

/** The nightly `prune-checks` job: delete checks older than the retention window. */
export async function pruneOldChecks(deps: {
  prune: (olderThan: Date) => Promise<number>;
  now?: () => Date;
  log: (message: string) => void;
}): Promise<number> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - CHECK_RETENTION_DAYS * 24 * 3_600_000);
  const deleted = await deps.prune(cutoff);
  deps.log(`[prune] deleted ${deleted} checks older than ${cutoff.toISOString()}`);
  return deleted;
}

async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

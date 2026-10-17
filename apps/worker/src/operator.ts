import { BlockedUrlError, parsePublicHttpUrl } from '@deployhealth/core';
import { BACKUP_STALE_DAYS, WORKER_HEARTBEAT_MAX_AGE_SECONDS } from '@deployhealth/db';
import { errorLabel } from './jobs';

/**
 * Alerts for whoever runs deployhealth, posted to OPERATOR_WEBHOOK_URL (Slack, or Discord with
 * /slack appended; `{ text }` like project alerts, through the guarded webhook sender):
 * - the check-endpoints heartbeat is older than WORKER_HEARTBEAT_MAX_AGE_SECONDS (uptime checks
 *   aren't running), then once more when it recovers;
 * - a queue's job failed FAILURES_BEFORE_ALERT times in a row, then once more when it succeeds;
 * - the backup service's 'backup' heartbeat is older than BACKUP_STALE_DAYS (at most once a day),
 *   then once more when it's fresh. Backups count as set up once that row exists (the first run
 *   writes it), so the worker needs no backup setting and never holds the R2 keys.
 * Messages name queues, counts and an error's name and code, never a message, URL or value.
 * A dead worker process can't post about itself: the external monitor on /api/health/worker
 * covers that (docs/deploy-railway.md, step 9).
 */

/** Consecutive failures of one queue before an alert. */
export const FAILURES_BEFORE_ALERT = 3;
/** The same alert (one kind: the heartbeat, or one queue) at most once per this long. */
export const ALERT_REPEAT_MS = 60 * 60_000;
/** At most this many alerts per rolling hour, whatever their kinds. */
export const MAX_ALERTS_PER_HOUR = 10;
/** The stale-backup alert repeats at most once a day: the backup service runs daily. */
export const BACKUP_ALERT_REPEAT_MS = 24 * 3_600_000;
/** How often the heartbeat watch reads the heartbeat's age. */
export const HEARTBEAT_WATCH_INTERVAL_MS = 60_000;

export interface OperatorAlertDeps {
  /** Post `{ text }`; resolves false (never throws) when it couldn't. */
  send: (text: string) => Promise<boolean>;
  log: (message: string) => void;
  now?: () => number;
}

export interface OperatorAlerts {
  jobFailed(queue: string, error: unknown): Promise<void>;
  jobSucceeded(queue: string): Promise<void>;
  /** The heartbeat's age in seconds (null: never written). */
  heartbeat(ageSeconds: number | null): Promise<void>;
  /** The backup heartbeat's age in seconds (null: backups aren't set up yet, so nothing to say). */
  backupHeartbeat(ageSeconds: number | null): Promise<void>;
}

/** The webhook URL when it's a public http(s) URL, else null with one error line (alerts stay off). */
export function operatorWebhookUrl(raw: string | null, log: (message: string) => void): string | null {
  if (!raw) return null;
  try {
    return parsePublicHttpUrl(raw).href;
  } catch (error) {
    // The guard's messages name the host at most, never the path that holds the webhook's secret.
    log(`[operator] OPERATOR_WEBHOOK_URL is not usable (${error instanceof BlockedUrlError ? error.message : 'invalid'}); operator alerts are off`);
    return null;
  }
}

export function createOperatorAlerts(deps: OperatorAlertDeps): OperatorAlerts {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const failures = new Map<string, number>();
  const lastSentAt = new Map<string, number>();
  const sentAt: number[] = [];
  let heartbeatStale = false;
  let backupStale = false;

  async function notify(kind: string, text: string, repeatMs = ALERT_REPEAT_MS): Promise<void> {
    const at = now();
    const last = lastSentAt.get(kind);
    if (last !== undefined && at - last < repeatMs) return;
    while (sentAt.length > 0 && at - sentAt[0]! >= 60 * 60_000) sentAt.shift();
    if (sentAt.length >= MAX_ALERTS_PER_HOUR) {
      deps.log(`[operator] alert not sent (more than ${MAX_ALERTS_PER_HOUR} this hour): ${text}`);
      return;
    }
    lastSentAt.set(kind, at);
    sentAt.push(at);
    deps.log(`[operator] ${text}`);
    if (!(await deps.send(`[deployhealth worker] ${text}`))) deps.log('[operator] the alert could not be posted');
  }

  return {
    async jobFailed(queue, error) {
      const count = (failures.get(queue) ?? 0) + 1;
      failures.set(queue, count);
      if (count >= FAILURES_BEFORE_ALERT) await notify(`job:${queue}`, `${queue} failed ${count} times in a row (last error: ${errorLabel(error)}).`);
    },

    async jobSucceeded(queue) {
      const count = failures.get(queue) ?? 0;
      failures.delete(queue);
      if (count >= FAILURES_BEFORE_ALERT) {
        lastSentAt.delete(`job:${queue}`);
        await notify(`job:${queue}:ok`, `${queue} is succeeding again after ${count} failures in a row.`);
      }
    },

    async heartbeat(ageSeconds) {
      // A new process gets one full window to write its first heartbeat (the previous one may
      // have stopped minutes ago, during the deploy).
      if (now() - startedAt < WORKER_HEARTBEAT_MAX_AGE_SECONDS * 1000) return;
      const stale = ageSeconds === null || ageSeconds > WORKER_HEARTBEAT_MAX_AGE_SECONDS;
      if (stale) {
        heartbeatStale = true;
        const age = ageSeconds === null ? 'has never been written' : `is ${Math.floor(ageSeconds / 60)} minutes old`;
        await notify('heartbeat', `the check-endpoints heartbeat ${age} (the limit is ${WORKER_HEARTBEAT_MAX_AGE_SECONDS / 60}): uptime checks aren't running.`);
      } else if (heartbeatStale) {
        heartbeatStale = false;
        lastSentAt.delete('heartbeat');
        await notify('heartbeat:ok', 'the check-endpoints heartbeat is fresh again: uptime checks are running.');
      }
    },

    async backupHeartbeat(ageSeconds) {
      if (ageSeconds === null) return;
      const days = ageSeconds / 86_400;
      if (days > BACKUP_STALE_DAYS) {
        backupStale = true;
        await notify('backup', `the backup service hasn't succeeded for ${Math.floor(days)} days (the limit is ${BACKUP_STALE_DAYS}): check its cron runs on Railway.`, BACKUP_ALERT_REPEAT_MS);
      } else if (backupStale) {
        backupStale = false;
        lastSentAt.delete('backup');
        await notify('backup:ok', 'the backup service is succeeding again.');
      }
    },
  };
}

/** Alerts that go nowhere, for when OPERATOR_WEBHOOK_URL isn't set. */
export const NO_OPERATOR_ALERTS: OperatorAlerts = {
  jobFailed: async () => {},
  jobSucceeded: async () => {},
  heartbeat: async () => {},
  backupHeartbeat: async () => {},
};

/**
 * Run one job for `queue`: a failure goes to `report` (Sentry) and the operator alerts, then is
 * thrown again so pg-boss retries as before; a success clears the queue's failure count.
 */
export async function observeJob<T>(queue: string, run: () => Promise<T>, deps: { report: (error: unknown, tags: Record<string, string>) => void; operator: OperatorAlerts }): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (error) {
    deps.report(error, { queue });
    await deps.operator.jobFailed(queue, error);
    throw error;
  }
  await deps.operator.jobSucceeded(queue);
  return result;
}

import { pgErrorCode } from '@deployhealth/db';

export const MIGRATION_POLL_MS = 5_000;
export const MIGRATION_WAIT_MS = 10 * 60_000;

export class MigrationsTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`database migrations still not applied after ${Math.round(waitedMs / 60_000)} minutes; exiting so the platform restarts the worker`);
    this.name = 'MigrationsTimeoutError';
  }
}

export interface WaitForMigrationsDeps {
  /** How many migrations this build ships that the database hasn't applied; throws if unreachable. */
  pending: () => Promise<number>;
  /** The number this build ships, for the log line. */
  total: number;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the database has every migration this worker was built with. Web's pre-deploy step
 * applies them, and the worker can start first. Polls every 5 s for up to 10 minutes, then throws
 * (the process exits non-zero and Railway restarts it). One log line per wait: the count, or the
 * error code when the database can't be reached, never an error message (it can name the host).
 */
export async function waitForMigrations(deps: WaitForMigrationsDeps): Promise<void> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? MIGRATION_POLL_MS;
  const timeoutMs = deps.timeoutMs ?? MIGRATION_WAIT_MS;
  const started = now();
  let waited = false;
  for (;;) {
    let reason: string;
    try {
      const pending = await deps.pending();
      if (pending === 0) {
        if (waited) deps.log(`[worker] database migrations applied after ${Math.round((now() - started) / 1000)}s`);
        return;
      }
      reason = `waiting for migrations: ${pending} of ${deps.total} not applied`;
    } catch (error) {
      reason = `waiting for the database (${pgErrorCode(error) ?? (error as Error)?.name ?? 'error'})`;
    }
    if (now() - started >= timeoutMs) throw new MigrationsTimeoutError(now() - started);
    deps.log(`[worker] ${reason}, next try in ${Math.round(intervalMs / 1000)}s`);
    waited = true;
    await sleep(intervalMs);
  }
}

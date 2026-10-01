import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { workerHeartbeats } from './schema';

/** The heartbeat check-endpoints writes; the deep health check reads only this one. */
export const CHECK_HEARTBEAT = 'check-endpoints';

/**
 * How recent the heartbeat must be for the worker to count as alive. check-endpoints runs every
 * minute and a run lasts at most about a minute (waves over 50 s, then a 10 s check budget), so
 * three minutes means at least one missed run, never a slow one.
 */
export const WORKER_HEARTBEAT_MAX_AGE_SECONDS = 180;

export async function recordHeartbeat(db: Db, name: string = CHECK_HEARTBEAT): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ name, lastRunAt: sql`now()` })
    .onConflictDoUpdate({ target: workerHeartbeats.name, set: { lastRunAt: sql`now()` } });
}

/** Whether check-endpoints finished a run in the last WORKER_HEARTBEAT_MAX_AGE_SECONDS (database clock). */
export async function workerIsHealthy(db: Db, maxAgeSeconds = WORKER_HEARTBEAT_MAX_AGE_SECONDS): Promise<boolean> {
  const result = await db.execute<{ healthy: boolean }>(
    sql`select exists (
      select 1 from ${workerHeartbeats}
      where ${workerHeartbeats.name} = ${CHECK_HEARTBEAT}
        and ${workerHeartbeats.lastRunAt} > now() - make_interval(secs => ${maxAgeSeconds})
    ) as healthy`,
  );
  return result.rows[0]?.healthy === true;
}

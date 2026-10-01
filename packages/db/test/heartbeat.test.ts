import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHECK_HEARTBEAT, recordHeartbeat, workerIsHealthy, WORKER_HEARTBEAT_MAX_AGE_SECONDS } from '../src/heartbeat';
import { workerHeartbeats } from '../src/schema';
import { openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

/** Move the heartbeat back by `seconds`, on the database clock. */
async function age(seconds: number) {
  await db.execute(sql`update ${workerHeartbeats} set last_run_at = now() - make_interval(secs => ${seconds})`);
}

describe('worker heartbeat', () => {
  it('is unhealthy before the worker has ever run', async () => {
    expect(await workerIsHealthy(db)).toBe(false);
  });

  it('is healthy right after a run, and keeps one row however often it runs', async () => {
    await recordHeartbeat(db);
    await recordHeartbeat(db);
    expect(await workerIsHealthy(db)).toBe(true);
    expect(await db.select().from(workerHeartbeats)).toEqual([{ name: CHECK_HEARTBEAT, lastRunAt: expect.any(Date) }]);
  });

  it('goes unhealthy once the last run is older than three minutes, and recovers on the next', async () => {
    expect(WORKER_HEARTBEAT_MAX_AGE_SECONDS).toBe(180);
    await recordHeartbeat(db);
    await age(170);
    expect(await workerIsHealthy(db)).toBe(true);
    await age(181);
    expect(await workerIsHealthy(db)).toBe(false);
    await recordHeartbeat(db);
    expect(await workerIsHealthy(db)).toBe(true);
  });

  it('reads only the check-endpoints heartbeat', async () => {
    await recordHeartbeat(db, 'something-else');
    expect(await workerIsHealthy(db)).toBe(false);
  });
});

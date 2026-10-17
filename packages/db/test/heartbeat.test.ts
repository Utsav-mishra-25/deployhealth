import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_HEARTBEAT, CHECK_HEARTBEAT, heartbeatAgeSeconds, recordHeartbeat, workerIsHealthy, WORKER_HEARTBEAT_MAX_AGE_SECONDS } from '../src/heartbeat';
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

  it('reports its age in seconds on the database clock, null before the first run', async () => {
    expect(await heartbeatAgeSeconds(db)).toBeNull();
    await recordHeartbeat(db);
    await age(200);
    const seconds = await heartbeatAgeSeconds(db);
    expect(seconds).toBeGreaterThanOrEqual(200);
    expect(seconds).toBeLessThan(205);
    expect(await heartbeatAgeSeconds(db, 'another')).toBeNull();
  });

  it("the backup service's row never counts for check-endpoints, in the deep health check or the operator watch", async () => {
    /** Move one named heartbeat back by `seconds`. */
    const ageOf = (name: string, seconds: number) =>
      db.execute(sql`update ${workerHeartbeats} set last_run_at = now() - make_interval(secs => ${seconds}) where name = ${name}`);

    // The daily backup run just succeeded, but check-endpoints is 10 minutes stale: unhealthy.
    await recordHeartbeat(db, CHECK_HEARTBEAT);
    await ageOf(CHECK_HEARTBEAT, 600);
    await recordHeartbeat(db, BACKUP_HEARTBEAT);
    expect(await workerIsHealthy(db)).toBe(false);
    expect(await heartbeatAgeSeconds(db, CHECK_HEARTBEAT)).toBeGreaterThanOrEqual(600);

    // check-endpoints fresh, the backup a day old (as it is between daily runs): healthy, no stale worker.
    await recordHeartbeat(db, CHECK_HEARTBEAT);
    await ageOf(BACKUP_HEARTBEAT, 86_400);
    expect(await workerIsHealthy(db)).toBe(true);
    expect(await heartbeatAgeSeconds(db, CHECK_HEARTBEAT)).toBeLessThan(5);
    expect(await heartbeatAgeSeconds(db, BACKUP_HEARTBEAT)).toBeGreaterThanOrEqual(86_400);
    // The default name is check-endpoints'.
    expect(await heartbeatAgeSeconds(db)).toBeLessThan(5);
  });
});

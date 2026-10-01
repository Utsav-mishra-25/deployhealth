import { describe, expect, it } from 'vitest';
import { MIGRATION_POLL_MS, MIGRATION_WAIT_MS, MigrationsTimeoutError, waitForMigrations } from '../src/readiness';

/** A fake clock: sleep advances it, so the loop runs in no real time. */
function harness(answers: (number | Error)[]) {
  let t = 0;
  const logs: string[] = [];
  const sleeps: number[] = [];
  let calls = 0;
  const deps = {
    pending: async () => {
      const answer = answers[Math.min(calls++, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    total: 8,
    log: (m: string) => logs.push(m),
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
  };
  return { deps, logs, sleeps, calls: () => calls };
}

const connRefused = () => Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 postgres://u:secret@db.internal/x'), { code: 'ECONNREFUSED' });

describe('waitForMigrations', () => {
  it('waits 5 s between tries, for up to 10 minutes, by default', () => {
    expect(MIGRATION_POLL_MS).toBe(5_000);
    expect(MIGRATION_WAIT_MS).toBe(600_000);
  });

  it('returns at once, silently, when the database is up to date', async () => {
    const h = harness([0]);
    await waitForMigrations(h.deps);
    expect(h.calls()).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it('waits while migrations are pending and returns once they are applied', async () => {
    const h = harness([1, 1, 0]);
    await waitForMigrations(h.deps);
    expect(h.sleeps).toEqual([5_000, 5_000]);
    expect(h.logs).toEqual([
      '[worker] waiting for migrations: 1 of 8 not applied, next try in 5s',
      '[worker] waiting for migrations: 1 of 8 not applied, next try in 5s',
      '[worker] database migrations applied after 10s',
    ]);
  });

  it('waits through an unreachable database, logging only the error code', async () => {
    const h = harness([connRefused(), 2, 0]);
    await waitForMigrations(h.deps);
    expect(h.logs[0]).toBe('[worker] waiting for the database (ECONNREFUSED), next try in 5s');
    expect(h.logs.join('\n')).not.toMatch(/secret|db\.internal|10\.1\.2\.3|postgres:/);
  });

  it('gives up after the timeout with an error, so the process exits non-zero', async () => {
    const h = harness([1]);
    await expect(waitForMigrations(h.deps)).rejects.toBeInstanceOf(MigrationsTimeoutError);
    // Tries at 0, 5, …, 600 s: the last one at the deadline, then it throws.
    expect(h.calls()).toBe(121);
    expect(h.logs).toHaveLength(120);
  });

  it('honours a custom interval and timeout', async () => {
    const h = harness([3]);
    await expect(waitForMigrations({ ...h.deps, intervalMs: 1_000, timeoutMs: 3_000 })).rejects.toThrow('still not applied');
    expect(h.sleeps).toEqual([1_000, 1_000, 1_000]);
  });
});

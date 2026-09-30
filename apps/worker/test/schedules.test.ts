import { DEMO_FRESHNESS, SCENARIO } from '@deployhealth/db/seed';
import { describe, expect, it } from 'vitest';
import { CHECK_QUEUE, PR_CHECK_QUEUE, PRUNE_QUEUE, RESEED_QUEUE } from '../src/jobs';
import { type BossQueues, CHECK_CRON, PRUNE_CRON, QUEUES, registerQueues, RESEED_CRON, RESEED_INTERVAL_MINUTES } from '../src/schedules';

function fakeBoss() {
  const calls: string[] = [];
  const schedules = new Map<string, string>();
  const created = new Map<string, unknown>();
  const updated = new Map<string, unknown>();
  const boss: BossQueues = {
    createQueue: async (name: string, options?: unknown) => {
      created.set(name, options);
      calls.push(`create ${name}`);
    },
    updateQueue: async (name: string, options?: unknown) => {
      updated.set(name, options);
      calls.push(`update ${name}`);
    },
    schedule: async (name: string, cron: string) => {
      schedules.set(name, cron);
      calls.push(`schedule ${name}`);
    },
    unschedule: async (name: string) => {
      schedules.delete(name);
      calls.push(`unschedule ${name}`);
    },
  };
  return { boss, calls, schedules, created, updated };
}

describe('worker schedules', () => {
  it('registers reseed-demo every 30 minutes for the public demo, with the other schedules', async () => {
    const { boss, schedules, created } = fakeBoss();
    await registerQueues(boss, { demo: true });
    expect(RESEED_CRON).toBe('*/30 * * * *');
    expect(Object.fromEntries(schedules)).toEqual({ [CHECK_QUEUE]: CHECK_CRON, [PRUNE_QUEUE]: PRUNE_CRON, [RESEED_QUEUE]: RESEED_CRON });
    expect([...created.keys()].sort()).toEqual([CHECK_QUEUE, PR_CHECK_QUEUE, PRUNE_QUEUE, RESEED_QUEUE].sort());
  });

  it('removes the reseed schedule when the demo is off, and still creates every queue', async () => {
    const { boss, schedules, calls, created } = fakeBoss();
    await registerQueues(boss, { demo: false });
    expect(schedules.has(RESEED_QUEUE)).toBe(false);
    expect(calls).toContain(`unschedule ${RESEED_QUEUE}`);
    expect(created.has(RESEED_QUEUE)).toBe(true);
    expect(created.has(PR_CHECK_QUEUE)).toBe(true);
  });

  it('creates each queue before scheduling it', async () => {
    const { boss, calls } = fakeBoss();
    await registerQueues(boss, { demo: true });
    for (const name of [CHECK_QUEUE, PRUNE_QUEUE, RESEED_QUEUE]) {
      expect(calls.indexOf(`create ${name}`)).toBeLessThan(calls.indexOf(`schedule ${name}`));
    }
  });

  it('keeps the demo fresh between reseeds: the incident deploy stays inside the window', () => {
    // Right after a reseed the deploy is deployMinutesAgo old; just before the next, that + the interval.
    expect(SCENARIO.deployMinutesAgo).toBeGreaterThanOrEqual(DEMO_FRESHNESS.minDeployAgeMinutes);
    expect(SCENARIO.deployMinutesAgo + RESEED_INTERVAL_MINUTES).toBeLessThanOrEqual(DEMO_FRESHNESS.maxDeployAgeMinutes);
    const maxDown = SCENARIO.deployMinutesAgo - SCENARIO.failureAfterDeployMinutes + RESEED_INTERVAL_MINUTES;
    expect(maxDown).toBeLessThan(DEMO_FRESHNESS.maxDownMinutes);
  });

  it('re-applies the options to queues that already exist (createQueue leaves them alone), except the policy', async () => {
    const { boss, updated } = fakeBoss();
    await registerQueues(boss, { demo: true });
    expect(updated.get(RESEED_QUEUE)).toEqual({ retryLimit: 5, retryDelay: 60, retryBackoff: true });
    for (const options of updated.values()) expect(options).not.toHaveProperty('policy');
  });

  it('retries a failed reseed with a delay, so it can wait for web to apply a new migration', () => {
    expect(QUEUES[RESEED_QUEUE]).toMatchObject({ policy: 'singleton', retryDelay: 60, retryBackoff: true });
    expect(QUEUES[RESEED_QUEUE]!.retryLimit).toBeGreaterThanOrEqual(3);
    expect(Object.values(QUEUES).map((q) => q.policy)).toEqual(['singleton', 'singleton', 'singleton', 'stately']);
  });
});

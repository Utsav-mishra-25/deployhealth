import type { PgBoss, Queue } from 'pg-boss';
import { CHECK_QUEUE, PR_CHECK_QUEUE, PRUNE_QUEUE, RESEED_QUEUE } from './jobs';

export const CHECK_CRON = '* * * * *';
/** Nightly, 03:17 UTC: roll complete days up into daily stats, then prune raw checks. */
export const PRUNE_CRON = '17 3 * * *';

/**
 * How often the public demo is reseeded. With the seed's deploy SCENARIO.deployMinutesAgo back,
 * a visitor always sees it between that and that + this many minutes old, inside DEMO_FRESHNESS
 * (packages/db/src/seed.ts; test/schedules.test.ts keeps the two in step).
 */
export const RESEED_INTERVAL_MINUTES = 30;
export const RESEED_CRON = `*/${RESEED_INTERVAL_MINUTES} * * * *`;

type QueueOptions = Omit<Queue, 'name'>;

/** Every queue is `singleton` (runs never overlap) except pr-check, which is `stately` per pull request. */
export const QUEUES: Record<string, QueueOptions> = {
  [CHECK_QUEUE]: { policy: 'singleton', retryLimit: 0, expireInSeconds: 120 },
  [PRUNE_QUEUE]: { policy: 'singleton', retryLimit: 2 },
  // A reseed that fails because web's pre-deploy hasn't applied a new migration yet (the worker
  // often starts first) retries after 1, 2, 4, 8 and 16 minutes instead of all at once.
  [RESEED_QUEUE]: { policy: 'singleton', retryLimit: 5, retryDelay: 60, retryBackoff: true },
  // A pull request opened during a deploy must not be dropped: six retries, the nth (from 0) after
  // 30 s × 2^n to twice that (pg-boss's jitter), at most 5 minutes, span about 17 to 22 minutes:
  // a web build, its pre-deploy migration and the worker's 10-minute migration wait. A job queued
  // while the worker waits uses no retries; it just waits too.
  [PR_CHECK_QUEUE]: { policy: 'stately', retryLimit: 6, retryDelay: 30, retryBackoff: true, retryDelayMax: 300, expireInSeconds: 600 },
};

export type BossQueues = Pick<PgBoss, 'createQueue' | 'updateQueue' | 'schedule' | 'unschedule'>;

/**
 * Create every queue and its schedule. createQueue does nothing for a queue that already exists,
 * so the options are applied again with updateQueue (all but the policy, which can't change).
 * reseed-demo runs only for the public demo (DEMO_PUBLIC=1); otherwise its schedule is removed,
 * in case an earlier deployment had it.
 */
export async function registerQueues(boss: BossQueues, { demo }: { demo: boolean }): Promise<void> {
  for (const [name, { policy, ...options }] of Object.entries(QUEUES)) {
    await boss.createQueue(name, { policy, ...options });
    await boss.updateQueue(name, options);
  }
  await boss.schedule(CHECK_QUEUE, CHECK_CRON);
  await boss.schedule(PRUNE_QUEUE, PRUNE_CRON);
  if (demo) await boss.schedule(RESEED_QUEUE, RESEED_CRON);
  else await boss.unschedule(RESEED_QUEUE);
}

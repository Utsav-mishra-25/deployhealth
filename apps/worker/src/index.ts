import { claimDueEndpoints, createDb, pruneChecks, recordCheck } from '@deployhealth/db';
import { PgBoss } from 'pg-boss';
import { runCheck } from './check';
import { workerEnv } from './env';
import { CHECK_QUEUE, checkEndpoints, PRUNE_QUEUE, pruneOldChecks } from './jobs';
import { sendWebhook } from './webhook';

const log = (message: string) => console.log(message);

/**
 * Two pg-boss queues, both `singleton` so runs never overlap:
 * - check-endpoints, every minute: checks whatever is due (per-endpoint intervals live in
 *   endpoints.next_check_at, so there is no per-endpoint cron);
 * - prune-checks, nightly at 03:17 UTC: deletes checks older than 30 days.
 */
async function main(): Promise<void> {
  const { DATABASE_URL } = workerEnv();
  const handle = createDb(DATABASE_URL);
  const { db } = handle;
  const boss = new PgBoss(DATABASE_URL);
  boss.on('error', (error) => console.error('[worker] pg-boss error', error));

  await boss.start();
  await boss.createQueue(CHECK_QUEUE, { policy: 'singleton', retryLimit: 0, expireInSeconds: 120 });
  await boss.createQueue(PRUNE_QUEUE, { policy: 'singleton', retryLimit: 2 });
  await boss.schedule(CHECK_QUEUE, '* * * * *');
  await boss.schedule(PRUNE_QUEUE, '17 3 * * *');

  await boss.work(CHECK_QUEUE, async () => {
    const summary = await checkEndpoints({
      claimDue: () => claimDueEndpoints(db),
      check: (target) => runCheck(target),
      record: (endpointId, outcome) => recordCheck(db, endpointId, outcome),
      notify: (url, payload) => sendWebhook(url, payload, { log }),
      log,
    });
    if (summary.checked || summary.errors) log(`[check] ${JSON.stringify(summary)}`);
  });

  await boss.work(PRUNE_QUEUE, async () => {
    await pruneOldChecks({ prune: (olderThan) => pruneChecks(db, olderThan), log });
  });

  log(`[worker] ready: ${CHECK_QUEUE} every minute, ${PRUNE_QUEUE} nightly`);

  const shutdown = async (signal: string) => {
    log(`[worker] ${signal} received, stopping`);
    await boss.stop({ graceful: true });
    await handle.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('[worker] failed to start', error);
  process.exit(1);
});

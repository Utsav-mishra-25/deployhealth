import type { PrCheckJobData } from '@deployhealth/core';
import {
  claimDueEndpoints,
  createDb,
  findPrCheckTarget,
  findPrCommentId,
  pruneChecks,
  pruneDeliveries,
  recordCheck,
  rollupChecks,
  setPrCheckGithubIds,
  upsertPrCheck,
} from '@deployhealth/db';
import { seed } from '@deployhealth/db/seed';
import { PgBoss } from 'pg-boss';
import { runCheck } from './check';
import { workerEnv } from './env';
import { githubApi } from './github/api';
import { createGithubApp } from './github/app';
import { CHECK_QUEUE, checkEndpoints, PR_CHECK_QUEUE, prCheck, PRUNE_QUEUE, pruneOldChecks, RESEED_QUEUE, reseedDemo } from './jobs';
import { sendWebhook } from './webhook';

const log = (message: string) => console.log(message);

/**
 * pg-boss queues, all `singleton` so runs never overlap:
 * - check-endpoints, every minute: checks whatever is due (per-endpoint intervals live in
 *   endpoints.next_check_at, so there is no per-endpoint cron);
 * - prune-checks, nightly at 03:17 UTC: rolls complete days up into daily stats, then deletes
 *   raw checks from whole days more than 30 days back;
 * - reseed-demo, only when DEMO_PUBLIC=1: nightly at 04:41 UTC and once on start.
 * And pr-check (`stately` per pull request: one running, at most one waiting), queued by the web
 * app's GitHub webhook, worked only when the GitHub App is configured.
 */
async function main(): Promise<void> {
  const { DATABASE_URL, DEMO_PUBLIC, DEMO_BASE_URL, GITHUB_APP } = workerEnv();
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
    await pruneOldChecks({
      rollup: (before) => rollupChecks(db, before),
      prune: (olderThan) => pruneChecks(db, olderThan),
      pruneDeliveries: (olderThan) => pruneDeliveries(db, olderThan),
      log,
    });
  });

  await boss.createQueue(RESEED_QUEUE, { policy: 'singleton', retryLimit: 2 });
  if (DEMO_PUBLIC === '1' && DEMO_BASE_URL) {
    await boss.schedule(RESEED_QUEUE, '41 4 * * *');
    await boss.work(RESEED_QUEUE, async () => {
      await reseedDemo({ seed: (now) => seed(db, now, { baseUrl: DEMO_BASE_URL }), log });
    });
    await boss.send(RESEED_QUEUE, {});
  } else {
    await boss.unschedule(RESEED_QUEUE);
  }

  // Created either way, so the web app's webhook can always enqueue; worked only with the App set up.
  await boss.createQueue(PR_CHECK_QUEUE, { policy: 'stately', retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 });
  if (GITHUB_APP) {
    const app = createGithubApp(GITHUB_APP);
    await boss.work<PrCheckJobData>(PR_CHECK_QUEUE, { localConcurrency: 2 }, async ([job]) => {
      await prCheck(job!.data, {
        findTarget: (installationId, repo) => findPrCheckTarget(db, installationId, repo),
        findCommentId: (projectId, prNumber) => findPrCommentId(db, projectId, prNumber),
        saveCheck: (row) => upsertPrCheck(db, row),
        setGithubIds: (id, ids) => setPrCheckGithubIds(db, id, ids),
        api: (installationId, repo) => githubApi(app.forInstallation(installationId), repo),
        log,
      });
    });
  }

  log(
    `[worker] ready: ${CHECK_QUEUE} every minute, ${PRUNE_QUEUE} nightly${DEMO_PUBLIC === '1' ? `, ${RESEED_QUEUE} nightly and now` : ''}` +
      `, ${PR_CHECK_QUEUE} ${GITHUB_APP ? `on (GitHub App ${GITHUB_APP.appId})` : 'off (no GitHub App)'}`,
  );

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

import type { PrCheckJobData } from '@deployhealth/core';
import {
  BUNDLED_MIGRATIONS,
  claimDueEndpoints,
  createDb,
  findPrCheckTarget,
  findPrCommentId,
  pendingMigrations,
  pruneChecks,
  pruneDeliveries,
  recordCheck,
  recordHeartbeat,
  rollupChecks,
  setPrCheckGithubIds,
  upsertPrCheck,
} from '@deployhealth/db';
import { seed } from '@deployhealth/db/seed';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgBoss } from 'pg-boss';
import { runCheck } from './check';
import { workerEnv } from './env';
import { githubApi } from './github/api';
import { createGithubApp } from './github/app';
import { isolateEntry } from './pr-check/isolate';
import { CHECK_QUEUE, checkEndpoints, errorLabel, PR_CHECK_QUEUE, prCheck, PRUNE_QUEUE, pruneOldChecks, RESEED_QUEUE, reseedDemo } from './jobs';
import { waitForMigrations } from './readiness';
import { registerQueues, RESEED_INTERVAL_MINUTES } from './schedules';
import { sendWebhook } from './webhook';

const log = (message: string) => console.log(message);

/**
 * pg-boss queues (options and schedules in ./schedules), all `singleton` so runs never overlap:
 * - check-endpoints, every minute: checks whatever is due (per-endpoint intervals live in
 *   endpoints.next_check_at, so there is no per-endpoint cron);
 * - prune-checks, nightly at 03:17 UTC: rolls complete days up into daily stats, then deletes
 *   raw checks from whole days more than 30 days back;
 * - reseed-demo, only when DEMO_PUBLIC=1: every 30 minutes and once on start.
 * And pr-check (`stately` per pull request: one running, at most one waiting), queued by the web
 * app's GitHub webhook, worked only when the GitHub App is configured.
 */
async function main(): Promise<void> {
  const { DATABASE_URL, DEMO_PUBLIC, DEMO_BASE_URL, GITHUB_APP } = workerEnv();
  const handle = createDb(DATABASE_URL);
  const { db } = handle;
  // Web's pre-deploy step migrates the database, and this process can start first: work no queue
  // (and don't start pg-boss) until every migration this build ships is applied.
  await waitForMigrations({ pending: () => pendingMigrations(db), total: BUNDLED_MIGRATIONS.length, log });
  const boss = new PgBoss(DATABASE_URL);
  boss.on('error', (error) => console.error('[worker] pg-boss error', error));

  await boss.start();
  const demoBaseUrl = DEMO_PUBLIC === '1' ? DEMO_BASE_URL : null;
  const demo = demoBaseUrl !== null;
  // Every queue is created either way, so the web app's webhook can always enqueue pr-check.
  await registerQueues(boss, { demo });

  await boss.work(CHECK_QUEUE, async () => {
    const summary = await checkEndpoints({
      claimDue: () => claimDueEndpoints(db),
      check: (target) => runCheck(target),
      record: (endpointId, outcome) => recordCheck(db, endpointId, outcome),
      notify: (url, payload) => sendWebhook(url, payload, { log }),
      heartbeat: () => recordHeartbeat(db),
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

  if (demoBaseUrl !== null) {
    await boss.work(RESEED_QUEUE, async () => {
      await reseedDemo({ seed: (now) => seed(db, now, { baseUrl: demoBaseUrl }), log });
    });
    await boss.send(RESEED_QUEUE, {});
  }

  // Worked only with the GitHub App set up.
  if (GITHUB_APP) {
    const app = createGithubApp(GITHUB_APP);
    // The isolate's entry is a second file in dist/; without it every check fails (and retries).
    const isolateFile = fileURLToPath(isolateEntry().file);
    if (!existsSync(isolateFile)) console.error(`[worker] ERROR: ${isolateFile} is missing; every pull request check will fail. Rebuild the worker.`);
    const runPrCheck = (data: PrCheckJobData) =>
      prCheck(data, {
        findTarget: (installationId, repo) => findPrCheckTarget(db, installationId, repo),
        findCommentId: (projectId, prNumber) => findPrCommentId(db, projectId, prNumber),
        saveCheck: (row) => upsertPrCheck(db, row),
        setGithubIds: (id, ids) => setPrCheckGithubIds(db, id, ids),
        api: (installationId, repo) => githubApi(app.forInstallation(installationId), repo, { appId: GITHUB_APP.appId }),
        log,
      });
    await boss.work<PrCheckJobData>(PR_CHECK_QUEUE, { localConcurrency: 2 }, async ([job]) => {
      try {
        await runPrCheck(job!.data);
      } catch (error) {
        log(`[pr-check] ${job!.data.repoFullName}#${job!.data.prNumber} failed (the queue retries it up to 6 times): ${errorLabel(error)}`);
        throw error;
      }
    });
  }

  log(
    `[worker] ready: ${CHECK_QUEUE} every minute, ${PRUNE_QUEUE} nightly${demo ? `, ${RESEED_QUEUE} every ${RESEED_INTERVAL_MINUTES} minutes and now` : ''}` +
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

import { escapeChatText, type AlertWebhookJobData, type PrCheckJobData } from '@deployhealth/core';
import {
  alertWebhookTarget,
  BACKUP_HEARTBEAT,
  BUNDLED_MIGRATIONS,
  CHECK_HEARTBEAT,
  claimDueEndpoints,
  countDueEndpoints,
  createDb,
  findPrCheckTarget,
  findPrCommentId,
  heartbeatAgeSeconds,
  pendingMigrations,
  pruneChecks,
  pruneAccountDeletions,
  pruneDeliveries,
  recordCheck,
  recordHeartbeat,
  rollupChecks,
  setPrCheckGithubIds,
  upsertPrCheck,
} from '@deployhealth/db';
import { installConsoleRedaction } from '@deployhealth/db/redact';
import { seed } from '@deployhealth/db/seed';
import { flushReports, initSentry, reportError } from '@deployhealth/db/sentry';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgBoss } from 'pg-boss';
import { runCheck } from './check';
import { workerEnv } from './env';
import { githubApi } from './github/api';
import { createGithubApp } from './github/app';
import { isolateEntry } from './pr-check/isolate';
import {
  ALERT_WEBHOOK_QUEUE,
  CHECK_QUEUE,
  backlogBeyondSpacing,
  checkEndpoints,
  checkSummaryLine,
  checkSummaryWorthLogging,
  errorLabel,
  PR_CHECK_QUEUE,
  prCheck,
  PRUNE_QUEUE,
  pruneOldChecks,
  RESEED_QUEUE,
  reseedDemo,
  sendAlertWebhook,
} from './jobs';
import { createOperatorAlerts, HEARTBEAT_WATCH_INTERVAL_MS, NO_OPERATOR_ALERTS, observeJob, operatorWebhookUrl } from './operator';
import { waitForMigrations } from './readiness';
import { registerQueues, RESEED_INTERVAL_MINUTES } from './schedules';
import { sendWebhook } from './webhook';

// Every line this process prints (ours, pg-boss's, Octokit's) is redacted: no tokens, webhook
// URLs, cookies or env values (@deployhealth/db/redact).
installConsoleRedaction();

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
  const { DATABASE_URL, NODE_ENV, DEMO_PUBLIC, DEMO_BASE_URL, GITHUB_APP, SENTRY_DSN, RAILWAY_GIT_COMMIT_SHA, OPERATOR_WEBHOOK_URL } = workerEnv();
  // Optional: error reports (SENTRY_DSN) and operator alerts (OPERATOR_WEBHOOK_URL). A value that
  // doesn't parse turns its feature off with one log line; the worker runs either way.
  initSentry({ dsn: SENTRY_DSN, release: RAILWAY_GIT_COMMIT_SHA, environment: NODE_ENV }, 'worker', log);
  const operatorUrl = operatorWebhookUrl(OPERATOR_WEBHOOK_URL, log);
  const operator = operatorUrl ? createOperatorAlerts({ send: (text) => sendWebhook(operatorUrl, { text: escapeChatText(text) }, { log }), log }) : NO_OPERATOR_ALERTS;
  // Every job: a failure is reported (Sentry) and counted (operator alerts), then thrown again.
  const observed = <T>(queue: string, run: () => Promise<T>) => observeJob(queue, run, { report: reportError, operator });

  const handle = createDb(DATABASE_URL);
  const { db } = handle;
  // Web's pre-deploy step migrates the database, and this process can start first: work no queue
  // (and don't start pg-boss) until every migration this build ships is applied.
  await waitForMigrations({ pending: () => pendingMigrations(db), total: BUNDLED_MIGRATIONS.length, log });
  const boss = new PgBoss(DATABASE_URL);
  boss.on('error', (error) => console.error(`[worker] pg-boss error: ${errorLabel(error)}`));

  await boss.start();
  const demoBaseUrl = DEMO_PUBLIC === '1' ? DEMO_BASE_URL : null;
  const demo = demoBaseUrl !== null;
  // Every queue is created either way, so the web app's webhook can always enqueue pr-check.
  await registerQueues(boss, { demo });

  // When this process last started a check of each hostname: keeps per-host spacing across runs.
  const hostStarts = new Map<string, number>();
  await boss.work(CHECK_QUEUE, () =>
    observed(CHECK_QUEUE, async () => {
      const summary = await checkEndpoints({
        claimDue: () => claimDueEndpoints(db),
        countDue: (hostsAtCap) => countDueEndpoints(db, { hostsAtCap }),
        check: (target) => runCheck(target),
        record: (endpointId, outcome) => recordCheck(db, endpointId, outcome),
        notify: (url, payload) => sendWebhook(url, payload, { log }),
        heartbeat: () => recordHeartbeat(db),
        log,
        report: (error) => reportError(error, { queue: CHECK_QUEUE }),
        hostStarts,
      });
      if (checkSummaryWorthLogging(summary)) log(checkSummaryLine(summary));
      const backlog = backlogBeyondSpacing(summary);
      if (backlog !== null) await operator.checkBacklog(backlog);
    }),
  );

  await boss.work<AlertWebhookJobData>(ALERT_WEBHOOK_QUEUE, ([job]) =>
    observed(ALERT_WEBHOOK_QUEUE, () =>
      sendAlertWebhook(job!.data, {
        target: (projectId) => alertWebhookTarget(db, projectId),
        notify: (url, payload) => sendWebhook(url, payload, { log }),
        log,
      }),
    ),
  );

  await boss.work(PRUNE_QUEUE, () =>
    observed(PRUNE_QUEUE, () =>
      pruneOldChecks({
        rollup: (before) => rollupChecks(db, before),
        prune: (olderThan) => pruneChecks(db, olderThan),
        pruneDeliveries: (olderThan) => pruneDeliveries(db, olderThan),
        pruneAccountDeletions: (olderThan) => pruneAccountDeletions(db, olderThan),
        log,
      }),
    ),
  );

  if (demoBaseUrl !== null) {
    await boss.work(RESEED_QUEUE, () => observed(RESEED_QUEUE, () => reseedDemo({ seed: (now) => seed(db, now, { baseUrl: demoBaseUrl }), log })));
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
    await boss.work<PrCheckJobData>(PR_CHECK_QUEUE, { localConcurrency: 2 }, ([job]) =>
      observed(PR_CHECK_QUEUE, async () => {
        try {
          await runPrCheck(job!.data);
        } catch (error) {
          log(`[pr-check] ${job!.data.repoFullName}#${job!.data.prNumber} failed (the queue retries it up to 6 times): ${errorLabel(error)}`);
          throw error;
        }
      }),
    );
  }

  log(
    `[worker] ready: ${CHECK_QUEUE} every minute, ${PRUNE_QUEUE} nightly${demo ? `, ${RESEED_QUEUE} every ${RESEED_INTERVAL_MINUTES} minutes and now` : ''}` +
      `, ${ALERT_WEBHOOK_QUEUE} on, ${PR_CHECK_QUEUE} ${GITHUB_APP ? `on (GitHub App ${GITHUB_APP.appId})` : 'off (no GitHub App)'}`,
  );

  // The heartbeat watch runs on its own timer, not as a pg-boss job, so it still fires when the
  // queues are stuck. Only with operator alerts on. It also reads the backup service's heartbeat
  // (a separate Railway service; this process holds no R2 keys).
  const watch = operatorUrl
    ? setInterval(() => {
        // Each by name: the backup row never stands in for check-endpoints', nor the reverse.
        heartbeatAgeSeconds(db, CHECK_HEARTBEAT)
          .then((age) => operator.heartbeat(age))
          .then(() => heartbeatAgeSeconds(db, BACKUP_HEARTBEAT))
          .then((age) => operator.backupHeartbeat(age))
          .catch((error: unknown) => log(`[operator] heartbeat not read: ${errorLabel(error)}`));
      }, HEARTBEAT_WATCH_INTERVAL_MS)
    : null;
  watch?.unref();

  const shutdown = async (signal: string) => {
    log(`[worker] ${signal} received, stopping`);
    if (watch) clearInterval(watch);
    await boss.stop({ graceful: true });
    await flushReports();
    await handle.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (error: unknown) => {
  // The stack, not the error object: its own fields (a pg error's detail) can quote row values.
  console.error(`[worker] failed to start: ${error instanceof Error ? (error.stack ?? errorLabel(error)) : errorLabel(error)}`);
  reportError(error, { phase: 'start' });
  await flushReports();
  process.exit(1);
});

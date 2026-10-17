# Worker (`apps/worker`)

The pg-boss process: migration wait, uptime checks and alerts, the nightly prune, the demo reseed,
the pull request check queue, operator alerts and error reports, and the backup service and restore
command (same package, separate entry points). Read before changing anything under `apps/worker` (the PR check
itself is in [github-app.md](github-app.md), SSRF and caps in [security.md](security.md)).

## Layout

```
  worker/             plain Node process running pg-boss
    src/index.ts      redacted console first; Sentry and operator alerts (both optional); waits for
                      migrations, then wires queues and real deps: check-endpoints, prune-checks,
                      reseed-demo, pr-check (each through observeJob), and the heartbeat watch
    src/readiness.ts  waitForMigrations(): poll every 5 s, up to 10 minutes, then throw (exit 1)
    src/schedules.ts  every queue's options and cron (registerQueues: create, re-apply options, schedule)
    src/jobs.ts       job logic with injected deps (claim → check → record → webhook; rollup → prune; reseed;
                      prCheck; sendAlertWebhook)
    src/check.ts      runCheck(): 10s budget, ≤5 redirects, no bodies; a HEAD answered 405 retries once as GET
    src/webhook.ts    POST {text}, 5s timeout, at most one retry, SSRF-guarded
    src/operator.ts   operator alerts (OPERATOR_WEBHOOK_URL): heartbeat watch, repeated job failures,
                      rate limits; observeJob() (report + count every job's failures)
    src/guarded-http.ts  the ONLY outbound HTTP: guardedRequest / guardedPost on node:http(s) + guardedLookup,
                      githubFetch (Octokit's fetch: api.github.com only, keep-alive, response cap) and
                      r2Request (Cloudflare R2 hosts only, for backups)
    src/env.ts        the ONLY place the worker reads process.env (workerEnv, backupEnv, restoreEnv)
    src/backup/r2.ts  the backup bucket: aws4-signed put / list / delete / get through r2Request
    src/backup/run.ts the backup service's daily run (deletions.json, a dump when due, prune, heartbeat), withRetries
    src/backup/restore.ts  restore logic: --list, --download, restore into an empty database + re-apply deletions
    src/backup-cli.ts dist/backup.js: the backup service's command (Railway cron)
    src/restore-cli.ts dist/restore.js: the operator's restore command (docs/maintenance.md)
    backup.Dockerfile the backup service's image: this package plus PGDG's postgresql-client-18 (not named
                      `Dockerfile`, so nothing auto-detects it for the worker, which stays on Railpack)
    railway.json      documentation only, like web's; railway.backup.json, the backup service's
```

## Conventions

- **Worker jobs** live in `apps/worker/src/jobs.ts` as plain functions with injected dependencies,
  so they're unit-tested without pg-boss. `index.ts` only wires queues, schedules and real deps.
  Every scheduled queue uses the `singleton` policy; `pr-check` is `stately` (see
  [github-app.md](github-app.md)) and `alert-webhook` is `standard`. Checks are scheduled per endpoint via `next_check_at`,
  never with a cron per endpoint.

## Worker jobs

- **Migration wait** (`readiness.ts`, before `boss.start()`, so no queue is worked): the worker
  counts the bundled journal's migrations missing from `drizzle.__drizzle_migrations` (matched on
  the journal's `when` = drizzle's `created_at`; a database ahead of the build is ready; no drizzle
  schema = all pending). Pending or unreachable → one log line (the count, or the pg error code,
  never a message or the connection string), retry in 5 s; after 10 minutes it throws and the
  process exits 1 (Railway's `ALWAYS` restart).
- **check-endpoints** (every minute): `claimDueEndpoints()` (one claimer at a time, advisory
  lock) takes enabled endpoints with `next_check_at <= now`, at most 5 per hostname and 50 per
  owner, owners taking turns (each owner's oldest, then each one's second, …), and gives each a start time with `assignHostSlots()`: checks of one hostname start at least
  10 s apart **across all users**, on a 10 s grid within the next 50 s. `check_hosts` stores each
  hostname's next free slot; an endpoint that gets no slot stays due and goes first next run. Each
  claimed endpoint's `next_check_at` becomes its start + interval. The job runs the claim in waves
  by start time (never early), up to 10 checks at a time with `runCheck()`, stores each result
  with `recordCheck()`, and starts the webhook for an alert event after the transaction commits,
  outside the check slots (the run awaits every send before the heartbeat). Failures log the
  endpoint's host and the error's name and code, never its URL or message. Right after the claim
  it counts the enabled endpoints still due (`countDueEndpoints()`); a run that claimed something,
  errored or left endpoints due logs one line, counts only:
  `[check] {"claimed":3,"checked":3,"failed":1,"opened":1,"resolved":0,"errors":0,"due_but_unclaimed":0,"run_ms":5120}`. Every
  run ends with `recordHeartbeat()` (the `worker_heartbeats` row `check-endpoints`, `now()`), even
  with nothing due; a claim that throws skips it, a failed write is logged. The deep health check
  reads that row.
- **prune-checks** (nightly, 03:17 UTC): first `rollupChecks()` writes one `endpoint_daily_stats`
  row per endpoint per complete UTC day (idempotent upsert), then `pruneChecks()` deletes raw checks
  from whole days more than 30 days back. A failed rollup deletes nothing. It also deletes webhook
  delivery ids older than 24 h and `account_deletions` records older than 35 days.
- **reseed-demo** (only with `DEMO_PUBLIC=1`, which also needs `DEMO_BASE_URL`): every 30 minutes
  (`RESEED_CRON`) and once on start, runs the seed so production needs no manual seed step and the
  incident stays recent. About a second; logs its duration, never the token. Retries up to 5 times,
  1 → 16 minutes apart, so a start before web has applied a new migration heals itself.
- **alert-webhook** (queued by the web app when pausing an endpoint resolves its alert; web makes
  no outbound HTTP): `{ projectId, type, message }`, never the URL. `sendAlertWebhook()` reads the
  project's current name and webhook URL (`alertWebhookTarget()`), logs the event like
  check-endpoints does, and sends through `sendWebhook` (its own one retry). The queue is
  `standard`, `retryLimit: 0`, expiring after 60 s: a late webhook is noise. A job queued before
  the worker has created the queue (the minutes of a first deploy) is refused and logged by web.
- **Queue options** live in `schedules.ts` (`QUEUES`). pg-boss's `createQueue` ignores an existing
  queue, so `registerQueues()` re-applies every option with `updateQueue` (all but the policy, which
  can't change) on each start.
- **pr-check** (queued by the web app's GitHub webhook; worked only with the App configured):
  6 retries, 30 s backoff capped at 5 minutes (about 17–22 minutes in all), so a PR opened during
  a deploy outlasts the migration wait; `schedules.test.ts` pins the span. See
  [github-app.md](github-app.md). The nightly prune also deletes webhook delivery ids
  older than 24 h.

## Error reports and operator alerts

- **Logs** are redacted for the whole process: `installConsoleRedaction()` runs at module load in
  `index.ts`, before anything can print (security.md, "Logs and error reports").
- **Error reports** (`SENTRY_DSN`, `@deployhealth/db/sentry`): every job runs through
  `observeJob(queue, run, …)`, which reports a failure (tagged with the queue) and throws it again
  so pg-boss retries as before; check-endpoints also reports each endpoint's processing error
  (`deps.report`). A start failure is reported and flushed before the process exits.
- **Operator alerts** (`OPERATOR_WEBHOOK_URL`, `operator.ts`, through `sendWebhook` and its SSRF
  guard, `{ text }` escaped like project alerts): `observeJob` counts each queue's consecutive
  failures and alerts on the 3rd (`FAILURES_BEFORE_ALERT`), then once when it succeeds again; when
  check-endpoints leaves due endpoints unclaimed 5 runs in a row (`BACKLOG_RUNS_BEFORE_ALERT`:
  "check-endpoints left 12 due endpoints unclaimed 5 runs in a row: checks are falling behind
  their intervals."), then once when a run leaves none ("check-endpoints is claiming every due
  endpoint again."); a
  timer outside pg-boss (`HEARTBEAT_WATCH_INTERVAL_MS`, 1 minute) reads `heartbeatAgeSeconds()` and
  alerts when it's over `WORKER_HEARTBEAT_MAX_AGE_SECONDS`, after giving a new process that long to
  write its first, then once when it's fresh again. One alert per kind per hour, 10 per hour in
  all, in memory. Messages hold queue names, counts and `errorLabel()` only. A URL that isn't
  public http(s) logs one line and leaves alerts off; the worker runs either way. A dead process
  can't alert: the external monitor covers it (deploy-railway.md step 9).

## The backup service and restores

- **The backup service** is a separate Railway service (cron, daily at 03:41 UTC, restart policy
  Never) built from `apps/worker/backup.Dockerfile`; the worker itself still builds with Railpack and
  never holds the R2 keys. `backup.js` runs `runBackup()` with `withRetries()` (two retries, 1 and
  5 minutes apart): upload `deletions.json` (`deletionsManifest()`), then dump only when the newest
  dump is older than `BACKUP_DUMP_INTERVAL_DAYS` (6.5; a failed day retries the next), upload it as
  `deployhealth/<database time>.dump`, list to confirm, and only then delete all but the
  `BACKUP_RETENTION_WEEKS` (4) newest; finally the `backup` heartbeat. A failed run is reported
  through the shared Sentry module (`service:backup`) and exits 1. `assertToolCanReach()` refuses
  a `pg_dump` older than the server. Logs: keys, sizes, durations, counts; errors through
  `describeBackupError()` (our own BackupError and R2Error messages, else name and code).
- **The stale-backup alert** lives in the worker's heartbeat watch: `heartbeatAgeSeconds(db,
  BACKUP_HEARTBEAT)` older than `BACKUP_STALE_DAYS` (8) alerts at most once a day. Backups count
  as set up once the row exists (the first run writes it): no setting on the worker.
- **restore.js** (`backup/restore.ts`, injected deps, tested without R2 or Postgres; the real dump
  and restore are tested in packages/db): `--list`; `--download <dir>` (the dump under its bucket
  name and `deletions.json`); a restore from `--latest`, `--key` or `--file` into `--into`, which
  must be empty and must not be `DATABASE_URL`'s database (`sameDatabase()`). Deletions to
  re-apply come from `deletions.json` (the bucket's, or `--deletions-file`) and, with
  `--live-deletions`, `DATABASE_URL`'s `account_deletions` (read only); with none it refuses unless
  `--skip-deletions`. `--download --live-deletions` also saves the live database's deletions as
  `live-deletions.json`, and `--deletions-file` repeats, for the production restore's two steps. It prints each source and the manifest's age, then rows per table.

# Worker (`apps/worker`)

The pg-boss process: migration wait, uptime checks and alerts, the nightly prune, the demo reseed,
and the pull request check queue. Read before changing anything under `apps/worker` (the PR check
itself is in [github-app.md](github-app.md), SSRF and caps in [security.md](security.md)).

## Layout

```
  worker/             plain Node process running pg-boss
    src/index.ts      waits for migrations, then wires queues and real deps: check-endpoints, prune-checks,
                      reseed-demo, pr-check
    src/readiness.ts  waitForMigrations(): poll every 5 s, up to 10 minutes, then throw (exit 1)
    src/schedules.ts  every queue's options and cron (registerQueues: create, re-apply options, schedule)
    src/jobs.ts       job logic with injected deps (claim → check → record → webhook; rollup → prune; reseed;
                      prCheck)
    src/check.ts      runCheck(): 10s budget, ≤5 redirects, no bodies
    src/webhook.ts    POST {text}, 5s timeout, at most one retry, SSRF-guarded
    src/guarded-http.ts  the ONLY outbound HTTP: guardedRequest / guardedPost on node:http(s) + guardedLookup,
                      and githubFetch (Octokit's fetch: api.github.com only, keep-alive, response cap)
    src/env.ts        the ONLY place the worker reads process.env
    railway.json      documentation only, like web's
```

## Conventions

- **Worker jobs** live in `apps/worker/src/jobs.ts` as plain functions with injected dependencies,
  so they're unit-tested without pg-boss. `index.ts` only wires queues, schedules and real deps.
  Every queue uses the `singleton` policy except `pr-check`, which is `stately` (see
  [github-app.md](github-app.md)). Checks are scheduled per endpoint via `next_check_at`,
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
  endpoint's host and the error's name and code, never its URL or message. Every
  run ends with `recordHeartbeat()` (the `worker_heartbeats` row `check-endpoints`, `now()`), even
  with nothing due; a claim that throws skips it, a failed write is logged. The deep health check
  reads that row.
- **prune-checks** (nightly, 03:17 UTC): first `rollupChecks()` writes one `endpoint_daily_stats`
  row per endpoint per complete UTC day (idempotent upsert), then `pruneChecks()` deletes raw checks
  from whole days more than 30 days back. A failed rollup deletes nothing.
- **reseed-demo** (only with `DEMO_PUBLIC=1`, which also needs `DEMO_BASE_URL`): every 30 minutes
  (`RESEED_CRON`) and once on start, runs the seed so production needs no manual seed step and the
  incident stays recent. About a second; logs its duration, never the token. Retries up to 5 times,
  1 → 16 minutes apart, so a start before web has applied a new migration heals itself.
- **Queue options** live in `schedules.ts` (`QUEUES`). pg-boss's `createQueue` ignores an existing
  queue, so `registerQueues()` re-applies every option with `updateQueue` (all but the policy, which
  can't change) on each start.
- **pr-check** (queued by the web app's GitHub webhook; worked only with the App configured):
  6 retries, 30 s backoff capped at 5 minutes (about 17–22 minutes in all), so a PR opened during
  a deploy outlasts the migration wait; `schedules.test.ts` pins the span. See
  [github-app.md](github-app.md). The nightly prune also deletes webhook delivery ids
  older than 24 h.

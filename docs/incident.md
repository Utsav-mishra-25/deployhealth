# Incident runbook

What to check, in order, when deployhealth (or part of it) is down, and how to tell users on the
status page. The setup is in [deploy-railway.md](deploy-railway.md): three Railway services
(**web**, **worker**, **Postgres**; on the hosted instance web is named `deployhealth`), Cloudflare
in front of web, two external monitors (step 9), optional Sentry error reports, operator alerts and
a status page (steps 12–14), and daily backups to Cloudflare R2 (step 15).

## 0. Say so first

Within a few minutes of a confirmed problem, open an incident on the status page (Better Stack →
**Status pages** → your page → **Incidents** → **Report a new incident**):

| Field | Value |
| --- | --- |
| Affected | **Website and dashboard** (web), **Uptime checks and alerts** (worker) or **Pull request checks** (worker, GitHub App) |
| Status | **Investigating** |
| Message | One line of what users see, no guesses about the cause: "Uptime checks are delayed; alerts may arrive late. We're looking into it." |

Update it at each step below (**Identified**, **Monitoring**, **Resolved**), at least every 30
minutes while it's open. Never paste log lines, user names, repository names or URLs into it.

## 1. Which part is down?

| Signal | Means | Go to |
| --- | --- | --- |
| The **web** monitor (`/api/health`) is red | web isn't serving (or Cloudflare can't reach it) | 2 |
| Only the **worker** monitor (`/api/health/worker`) is red | web is up; `check-endpoints` hasn't finished a run in 3 minutes | 3 |
| Operator alert "heartbeat is N minutes old" | the worker process runs, but uptime checks don't | 3.3 |
| Operator alert "<queue> failed 3 times in a row" | one job keeps failing (the name and code are in the alert) | 3.4 |
| Operator alert "the backup service hasn't succeeded for N days" | the daily backup runs fail or stopped; no new dump | the backup service's Deployments (each run's log), deploy-railway.md troubleshooting |
| Both red | usually the database, or Railway itself | 4, then 2 and 3 |

Also look at <https://status.railway.com> and <https://www.cloudflarestatus.com>: if either has an
incident in your region, link it from your status page update and wait it out.

## 2. Web is down

1. **What does the browser get?** A Cloudflare error page (520–526, "Bad gateway") means Cloudflare
   can't reach Railway: go on to 2. A Cloudflare challenge (403) for the monitor means Bot Fight
   Mode: see step 9 of deploy-railway.md. A Railway "Application failed to respond" page means the
   domain's port is wrong or web crashed.
2. **Railway → web → Deployments.** Is the latest deployment **Crashed** or **Failed**?
   - A failed **pre-deploy** (migration) keeps the previous version serving; read its log, fix,
     push. Never edit an applied migration (maintenance.md).
   - A crash right after a deploy: **roll back** (the previous good deployment's ⋯ menu →
     **Rollback** or **Redeploy**), then investigate. A rollback doesn't undo migrations; they are additive (maintenance.md), so the
     previous code still runs on the newer schema.
3. **web's logs** (Deployments → the active one → **Logs**). Look for the startup errors in the
   troubleshooting table of deploy-railway.md (`Invalid environment for apps/web`,
   `AUTH_GITHUB_ID and AUTH_GITHUB_SECRET are required`, database connection errors such as
   `ECONNREFUSED`). Logs are redacted (tokens, webhook URLs, cookies and env values show as
   `[redacted]`), so they're safe to read and share with Railway support.
4. **Sentry** (if set up): **Issues**, filtered by `service:web` and the current release (the
   commit SHA). A new issue whose first event matches the outage's start points at the cause.
5. **Metrics** (web → **Metrics**): memory at the limit means a crash loop on out-of-memory; CPU
   pinned at 100% means add a replica (step 9) or find the hot route in Sentry.

## 3. The worker is down (web is up)

1. **Railway → worker → Deployments.** The worker restarts on its own (`ALWAYS`). Crash-looping
   after a deploy: roll back as in 2.2.
2. **worker's logs**, from the top of the current run:
   - `waiting for migrations: N of M not applied`: web's pre-deploy hasn't applied this build's
     migrations. Fix web first (2.2); the worker starts on its own once they're applied.
   - `failed to start: …`: the line says why (`DATABASE_URL`, `DEMO_BASE_URL`,
     `GITHUB_APP_PRIVATE_KEY is not a valid private key`, …). Fix the variable, then **Deploy**.
   - `pg-boss error: <name> <code>`: the queue can't reach Postgres: go to 4.
3. **The process runs but the heartbeat is stale** (operator alert, or `/api/health/worker` 503):
   look for `[check] … could not be processed: <name> <code>` lines and the Sentry issues tagged
   `queue:check-endpoints`. A claim that throws (database trouble) skips the heartbeat on purpose.
4. **One queue keeps failing** (operator alert names it): `prune-checks`, `reseed-demo` or
   `pr-check`. Its Sentry issues are tagged with the queue. pg-boss retries each failed job (see
   worker.md); fix the cause and the next run clears the alert ("succeeding again").
5. **Pull request checks only** (no monitor covers them): GitHub App → **Advanced** → **Recent
   Deliveries**. 401 means `GITHUB_APP_WEBHOOK_SECRET` on web doesn't match the App; 404 means
   it isn't set. Deliveries answered 202 but no check run: the worker's `[pr-check]` lines say why.
   After a fix, **Redeliver** the failed deliveries.

## 4. The database

1. **Railway → Postgres → Metrics**: disk (the volume) near full, or connections at the limit.
   A full volume: grow it (the Postgres service's volume settings), then restart web and worker.
2. **Postgres → Logs**: crash or recovery lines. Railway restarts it; web and worker reconnect on
   their own (the worker retries its migration check for 10 minutes, then restarts).
3. **Data looks wrong or missing**: stop the worker first, so nothing writes on top of it (its
   active deployment's ⋯ menu → **Remove**; redeploy it when you're done), then work out what
   happened before changing anything.
4. **Data is lost or damaged beyond repair**: restore the newest backup into a new Postgres
   service and switch to it ([maintenance.md](maintenance.md), "Restoring production"). It
   re-applies every account deletion made since the dump, so no deleted account comes back.

## 5. Close it

1. Both monitors green, the worker log shows `[check]` lines again, Sentry quiet.
2. Status page: **Monitoring** for 15–30 minutes, then **Resolved** with one line of what happened
   and what changed ("A deploy broke sign-in for 20 minutes; it was rolled back.").
3. **If user data was exposed or lost**, /security commits us to email every affected user within
   **72 hours** of confirming it, at the email address on their GitHub account: what happened,
   which data, what we're doing. Write it down the day it happens: start, end, cause, fix, and
   what would have caught it sooner.

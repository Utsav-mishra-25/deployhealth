# Maintenance runbook

Planned work on the hosted instance: downtime, migrations, restoring a backup, and rotating
secrets. The setup is in
[deploy-railway.md](deploy-railway.md); when something breaks instead, use [incident.md](incident.md).
Every variable below is set in Railway (service → **Variables**), never in a file or a chat, and
takes effect when you click **Deploy** on the staged-changes banner.

## Planned downtime

Most changes need none: web deploys with a health check (the old version serves until the new
one answers `/api/health`), and the worker picks up where it stopped. Plan downtime for a Postgres
major upgrade, a region move, or a migration that rewrites a large table.

1. **Announce it** at least 48 hours ahead: Better Stack → **Status pages** → your page →
   **Maintenance** → **Schedule maintenance**: the window (UTC), the affected parts (**Website and
   dashboard**, **Uptime checks and alerts**, **Pull request checks**) and one line of what users
   will see ("Sign-in and dashboards are unavailable for up to 30 minutes; uptime checks pause and
   resume afterwards; nothing is lost.").
2. **During the window** the status page shows the maintenance. Pause the two monitors in Better
   Stack (or give each a maintenance window) so they don't page you; operator alerts still fire (a
   stale heartbeat while the worker is stopped is expected).
3. **After**: both monitors green, the worker log shows `[check]` lines, then end the maintenance
   on the status page (it ends on its own at the window's end).

Uptime checks missed during downtime aren't replayed: endpoints are simply checked again when the
worker is back, and nothing is alerted for the gap.

**A Postgres major upgrade** (Railway's in-place upgrade, or a new service): the backup image's
client must keep up, or its version check refuses every dump. Before the upgrade, change
`postgresql-client-18` in `apps/worker/backup.Dockerfile` and `BACKUP_PG_MAJOR` in
`packages/db/src/backup.ts` to the new major, CI's `postgres:18` and `postgresql-client-18` too,
and merge; afterwards, run a backup (deploy-railway.md 15.5) and a test restore (below).

## Migrations

How they run: web's pre-deploy step (`node packages/db/dist/migrate.js`) applies them before the
new version takes traffic; the worker waits until its build's migrations are applied
(deploy-railway.md, step 4). A failed migration stops web's deploy and the previous version keeps
serving.

- **Write them additive.** New tables, nullable columns, new indexes: the previous code keeps
  working on the new schema, so a deploy can always be rolled back without touching the database.
- **Dropping or renaming takes two deploys.** First ship code that no longer reads the old column
  or table; then, in a later deploy, the migration that drops it.
- **Never edit an applied migration**; fix forward with a new one (`pnpm db:generate`).
- **A long migration** (a big table rewrite, an index on a large table without `CONCURRENTLY`)
  holds locks: schedule it as planned downtime.
- **Check before deploying**: `pnpm db:migrate` against a local copy of the schema, and the test
  suite (it migrates a fresh database on every run).

## Restore from backup

Backups are in the R2 bucket (deploy-railway.md, step 15): the 4 newest weekly dumps under
`deployhealth/<time>.dump` (the time just before each dump started, UTC) and `deletions.json`
(the account deletions on record, refreshed daily). The restore command, `restore.js`, restores a
dump **only into an empty database** (never the one `DATABASE_URL` names), then re-applies every
account deletion made at or after the dump's time, so a restore never brings a deleted account
back. It prints where the deletions came from and how old `deletions.json` is, then the rows per
table.

**What you need on your machine:** a checkout of this repository with `pnpm install` and
`pnpm --filter @deployhealth/worker... build`; PostgreSQL 18's client tools (`pg_restore --version`
says 18: macOS `brew install postgresql@18`, Debian or Ubuntu `postgresql-client-18` from
apt.postgresql.org); the Railway CLI, logged in and linked (`railway link`). `railway run --service
backup -- …` runs a command on your machine with the backup service's variables (the R2 keys)
in its environment, without printing them. Everything you download holds production data:
delete it when you're done.

### A test restore (do one after the first backup, and after any Postgres upgrade)

1. A scratch Postgres 18 and an empty database: `docker compose up -d` (this repo's, Postgres 18),
   then `createdb -h localhost -U deployhealth deployhealth_restore` (password `deployhealth`).
2. See what's there:

   ```sh
   railway run --service backup -- node apps/worker/dist/restore.js --list
   ```

   The dumps, newest first, with their sizes and ages, and when `deletions.json` was written.
3. Restore the newest:

   ```sh
   railway run --service backup -- node apps/worker/dist/restore.js --latest \
     --into postgres://deployhealth:deployhealth@localhost:5432/deployhealth_restore
   ```

   It downloads the dump, restores it, re-applies the deletions in `deletions.json` and prints the
   rows per table. Expect `re-applied N account deletions made since the dump` (often 0).
4. Check: the counts are close to production's (`node packages/db/dist/stats.js` in the web
   container, deploy-railway.md step 11, counts users and projects), and
   `drizzle.__drizzle_migrations` has as many rows as `packages/db/drizzle/` has migrations.
5. `dropdb -h localhost -U deployhealth deployhealth_restore`.

### Restoring production

Only when the database is lost or damaged beyond repair (incident.md, step 4). Restore into a
**new** Postgres service and switch to it; never restore over the old one.

1. Status page: an incident (incident.md, step 0). Stop the worker (its active deployment's ⋯
   menu → **Remove**) and clear the backup service's Cron Schedule, so nothing writes meanwhile.
2. If the old database still answers, run the backup service once (deploy-railway.md 15.5) so
   `deletions.json` holds every deletion up to now. If it doesn't, deletions made after the last
   `deletions.json` (at most a day old) can't be re-applied: the restore says how old it is, and
   those users can be deleted again by hand afterwards (deploy-railway.md, step 10).
3. Railway → **+ Create** → **Database** → **PostgreSQL** (major version 18, like the old one);
   name it, e.g., `Postgres-restored`. Turn on its **TCP Proxy** (Settings → Networking) for the
   restore only.
4. Download the dump and `deletions.json` with the backup service's keys:

   ```sh
   mkdir -p restore
   railway run --service backup -- node apps/worker/dist/restore.js --latest --download ./restore
   ```

5. Restore them into the new database with its own variables (`$DATABASE_PUBLIC_URL` is expanded
   inside the command, never printed):

   ```sh
   railway run --service Postgres-restored -- sh -c \
     'node apps/worker/dist/restore.js --file ./restore/<the dump>.dump --deletions-file ./restore/deletions.json --into "$DATABASE_PUBLIC_URL"'
   ```

6. Turn the new database's TCP Proxy off. Delete `./restore`.
7. Point every service at it: on **web**, **worker** and **backup**, change `DATABASE_URL` to
   `${{Postgres-restored.DATABASE_URL}}`. **Deploy** (web's pre-deploy migration step is a no-op on
   a restored database of the same version). Redeploy the worker; set the backup's Cron Schedule
   back to `41 3 * * *`.
8. Check `/api/health/worker` is green, sign in, open a project. Then update the status page.
   Keep the old Postgres service, unused, until you're sure; then delete it.

## Rotating the GitHub App's private key

GitHub lets an App have several private keys at once, so this needs no downtime.

1. GitHub → **Settings** → **Developer settings** → **GitHub Apps** → your App → **Private keys** →
   **Generate a private key**. GitHub downloads a `.pem`.
2. Encode it on one line (`base64 < deployhealth.*.private-key.pem | tr -d '\n'`), and set it as
   `GITHUB_APP_PRIVATE_KEY` on the **worker**. **Deploy**.
3. Check the worker's log shows `[worker] ready: … pr-check on (GitHub App <id>)` (it refuses to
   start with a key it can't parse), then open or push to a test pull request and see the
   `deployhealth / env` check run.
4. Back on GitHub, **Delete** the old key. Delete the downloaded `.pem`.

If a key leaked, do the same at once, and delete the old key before step 3.

## Rotating the GitHub App's webhook secret

GitHub keeps one webhook secret, so deliveries sent between the two changes are refused (401) and
need redelivering. Pull request checks are idempotent (each delivery id is processed once), so
redelivering is safe.

1. Generate a new secret: `openssl rand -hex 32`.
2. Set it as `GITHUB_APP_WEBHOOK_SECRET` on **web** and click **Deploy**. Wait for the deploy to go
   live (Deployments shows it active).
3. At once: GitHub App → **General** → **Webhook secret** → paste the same value → **Save changes**.
4. GitHub App → **Advanced** → **Recent Deliveries**: every delivery between 2 and 3 shows 401.
   Open each and **Redeliver**; they answer 202.

## Other secrets

| Secret | Where | Rotating it |
| --- | --- | --- |
| `AUTH_SECRET` | web | Signs everyone out. Without `REPORT_SHARE_SECRET` it also invalidates every share link. `openssl rand -base64 32`, set, Deploy |
| `REPORT_SHARE_SECRET` | web | Invalidates every report share link at once (the only way to revoke one). `openssl rand -base64 32`, set, Deploy |
| `AUTH_GITHUB_SECRET` | web | GitHub → the OAuth App → **Generate a new client secret**, set it, Deploy, then delete the old secret on GitHub |
| `SENTRY_DSN` | web, worker | Sentry → project → **Client Keys (DSN)** → generate a new key, set it on both, Deploy both, then disable the old key |
| The R2 token (`BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`) | backup | Cloudflare → R2 → **Manage API tokens** → create a new token like the old one (Object Read & Write, this bucket only), set both on the backup service, Deploy, check the next run (or run one, deploy-railway.md 15.5), then delete the old token |
| `OPERATOR_WEBHOOK_URL` | worker | Create a new incoming webhook (Slack or Discord), set it, Deploy, then delete the old webhook in Slack or Discord |
| A project's ingest token | the project's settings page | **Regenerate**, then update the repository secret `DEPLOYHEALTH_TOKEN` |

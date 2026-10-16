# Maintenance runbook

Planned work on the hosted instance: downtime, migrations, and rotating secrets. The setup is in
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
| `OPERATOR_WEBHOOK_URL` | worker | Create a new incoming webhook (Slack or Discord), set it, Deploy, then delete the old webhook in Slack or Discord |
| A project's ingest token | the project's settings page | **Regenerate**, then update the repository secret `DEPLOYHEALTH_TOKEN` |

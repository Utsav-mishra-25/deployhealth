# Database (`packages/db`)

The Drizzle schema, migrations, queries and their tests. Read before changing the schema or any
query (authorization rules for queries are in [security.md](security.md)).

## Layout

```
  db/                 Drizzle schema, migrations (drizzle/), queries, seed
    src/schema.ts     users, clients, projects, deploys, scans (+ env_scopes), findings, scan_variables (+ optional),
                      endpoints, checks, check_hosts, endpoint_daily_stats, alerts, installations,
                      installation_repos, pr_checks, webhook_deliveries, worker_heartbeats,
                      account_deletions
    src/queries.ts    users, projects (+ what a project's status reads), ingest (recordScan + variables),
                      deploys/scans reads
    src/deploy-history.ts  listDeployHistory(): each deploy's changes vs the previous scanned deploy
                      (findingsDiff) and the outage that started after it (owner-scoped)
    src/clients.ts    clients CRUD, /clients overview, project settings (client, webhook, deploy notes)
    src/monitoring.ts endpoints CRUD, claimDueEndpoints(), recordCheck() (+ alert lifecycle), stats,
                      uptimeBetween() (rollups + raw), rollupChecks(), prune
    src/handoff.ts    getHandoffData() (owner-scoped)
    src/reports.ts    getClientReport() (by client id; see Authorization in security.md)
    src/github.ts     installations, installation repos, webhook deliveries, pr_checks (worker upserts;
                      owner-scoped reads for the UI: status, PR list, agent stats)
    src/heartbeat.ts  recordHeartbeat() / workerIsHealthy() / heartbeatAgeSeconds(): the deep health
                      check's row and the operator alerts' watch
    src/migrations-status.ts  pendingMigrations(): the bundled drizzle journal vs drizzle.__drizzle_migrations
    src/onboarding.ts getOnboardingState(): the first-run checklist's data (own installations, projects,
                      endpoint, deploy and client counts; owner-scoped)
    src/dev-reset.ts  resetDevUser(): empties the dev account for e2e (test tooling; not exported)
    src/delete-user.ts  planUserDeletion() / deleteUser(): an account and everything it owns (not exported;
                      by login, GitHub id or user id), DELETION_TABLE_LABELS, pruneAccountDeletions()
    src/account.ts    the account page: planOwnAccountDeletion() / deleteOwnAccount() (by the signed-in
                      user's id), userExists()
    src/export.ts     exportUserData(): everything a user owns, one JSON document (owner-scoped)
    src/redact.ts     `@deployhealth/db/redact`: redactText / redactValue / scrubErrorEvent /
                      installConsoleRedaction (no database code; security.md, "Logs and error reports")
    src/sentry.ts     `@deployhealth/db/sentry`: Sentry for web and worker (initSentry, reportError)
    src/delete-user-cli.ts  `pnpm --filter @deployhealth/db delete-user`; built to dist/delete-user.js
    src/stats.ts      usageStats(): counts for the operator, in one READ ONLY transaction
    src/stats-cli.ts  `pnpm --filter @deployhealth/db stats`; built to dist/stats.js
```

## Schema changes

- **Schema changes:** edit `packages/db/src/schema.ts`, then `pnpm db:generate` and commit the new SQL in
  `packages/db/drizzle/`. Never edit a migration that has been applied. Only web's pre-deploy step
  applies migrations; the worker bundles the journal and waits for them (Worker jobs in [worker.md](worker.md)).

## Deleting a user

- **Self-serve** on /account (web): `deleteOwnAccount(db, userId)`, after a typed confirmation.
  **On request:** `/privacy` promises an emailed request deletes an account and everything it owns
  within `DELETION_REQUEST_DAYS` (web `lib/legal.ts`). The operator runs `delete-user` (`--login` or
  `--github-id`; a dry run of counts per table unless `--confirm`) in the web container: runbook in
  [docs/deploy-railway.md](../deploy-railway.md) step 10. No route, not exported from the package
  index. Both run `deleteUser()`, so the same rows go: in one transaction, the user's row (every
  owned table cascades from it) and the installations linked to them or installed from their
  GitHub id (repos and pull request checks cascade). It refuses GitHub ids ≤ 0 (demo, dev) and an
  ambiguous login, and the CLI prints logins, ids and counts only (installations also by account
  type, user or organization, for the reply). A table that gets a user's rows without cascading
  from `users`, `projects` or `installations` must join `DELETION_TABLES`, `DELETION_TABLE_LABELS`
  and `countOwned()`; `test/delete-user.test.ts` checks that only the other user's rows remain,
  either way.
- **`account_deletions`** (`github_id`, `deleted_at`; primary key on both, no foreign keys): one row
  per deletion, written in `deleteUser()`'s transaction, so a restore from a backup can re-apply
  every deletion newer than the dump. The nightly prune deletes rows older than
  `ACCOUNT_DELETION_RECORD_DAYS` (35, derived from `BACKUP_RETENTION_WEEKS` = 4 in `retention.ts`, which the backup job reads too). Migration 0009.

## Exporting a user's data

- `exportUserData(db, userId)` (`export.ts`, `format: "deployhealth-export/1"`): account,
  clients, projects, deploys, scans (findings and variables nested), endpoints (full URL, daily
  totals nested), alerts, pull request checks on the user's projects, and the installations linked
  to them or installed from their GitHub id, with repository names. Left out: token hashes and
  hints, alert webhook URLs (`alertWebhook: "set"`), raw checks, GitHub comment and check-run ids.
  One `READ ONLY`, `REPEATABLE READ` transaction. A new table a user owns joins it (and
  `test/export.test.ts`, `test/isolation.test.ts`).

## Usage counts

- `stats` (`--exclude-login <login>`, repeatable) prints counts only, never names, logins or
  repository names: users, GitHub App installations (on user accounts and organizations) and
  projects, each in total and created in the last 7 and 30 days; **weekly active projects** (a
  scan or a pull request check, by `pr_checks.updated_at`, in the last 7 days); scans and pull
  request checks (by `created_at`) in the last 7 days. It always leaves out the demo (-1) and dev
  (-2) users, the demo's installation, the `--exclude-login` users (case-insensitive), what they
  own, and installations linked to them or installed from their GitHub account; installations
  nobody has linked yet count. Everything runs in one `READ ONLY` transaction on the database
  clock (`test/stats.test.ts` checks that writes are refused and no table changes). Like
  delete-user it's operator-only: not owner-scoped, not exported, no route. Runbook:
  [docs/deploy-railway.md](../deploy-railway.md) step 11.

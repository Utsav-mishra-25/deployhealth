# Database (`packages/db`)

The Drizzle schema, migrations, queries and their tests. Read before changing the schema or any
query (authorization rules for queries are in [security.md](security.md)).

## Layout

```
  db/                 Drizzle schema, migrations (drizzle/), queries, seed
    src/schema.ts     users, clients, projects, deploys, scans (+ env_scopes), findings, scan_variables (+ optional),
                      endpoints, checks, check_hosts, endpoint_daily_stats, alerts, installations,
                      installation_repos, pr_checks, webhook_deliveries, worker_heartbeats
    src/queries.ts    users, projects, ingest (recordScan + variables), deploys/scans reads
    src/clients.ts    clients CRUD, /clients overview, project settings (client, webhook, deploy notes)
    src/monitoring.ts endpoints CRUD, claimDueEndpoints(), recordCheck() (+ alert lifecycle), stats,
                      uptimeBetween() (rollups + raw), rollupChecks(), prune
    src/handoff.ts    getHandoffData() (owner-scoped)
    src/reports.ts    getClientReport() (by client id; see Authorization in security.md)
    src/github.ts     installations, installation repos, webhook deliveries, pr_checks (worker upserts;
                      owner-scoped reads for the UI: status, PR list, agent stats)
    src/heartbeat.ts  recordHeartbeat() / workerIsHealthy(): the deep health check's one row
    src/migrations-status.ts  pendingMigrations(): the bundled drizzle journal vs drizzle.__drizzle_migrations
    src/delete-user.ts  planUserDeletion() / deleteUser(): an account and everything it owns (operator only)
    src/delete-user-cli.ts  `pnpm --filter @deployhealth/db delete-user`; built to dist/delete-user.js
```

## Schema changes

- **Schema changes:** edit `packages/db/src/schema.ts`, then `pnpm db:generate` and commit the new SQL in
  `packages/db/drizzle/`. Never edit a migration that has been applied. Only web's pre-deploy step
  applies migrations; the worker bundles the journal and waits for them (Worker jobs in [worker.md](worker.md)).

## Deleting a user on request

- `/privacy` promises an emailed request deletes an account and everything it owns within
  `DELETION_REQUEST_DAYS` (web `lib/legal.ts`). The operator runs `delete-user` (`--login` or
  `--github-id`; a dry run of counts per table unless `--confirm`) in the web container: runbook in
  [docs/deploy-railway.md](../deploy-railway.md) step 10. No route, not exported from the package
  index. One transaction: the user's row (every owned table cascades from it) and the
  installations linked to them or installed from their GitHub id (repos and pull request checks
  cascade). It refuses GitHub ids ≤ 0 (demo, dev) and an ambiguous login, and prints logins, ids
  and counts only (installations also by account type, user or organization, for the reply). A table that gets a user's rows without cascading from `users`, `projects` or
  `installations` must join `DELETION_TABLES` and `countOwned()`; `test/delete-user.test.ts` checks
  that only the other user's rows remain.

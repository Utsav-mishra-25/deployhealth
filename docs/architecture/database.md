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
    src/reports.ts    getClientReport() (by client id; see Authorization)
    src/github.ts     installations, installation repos, webhook deliveries, pr_checks (worker upserts;
                      owner-scoped reads for the UI: status, PR list, agent stats)
    src/heartbeat.ts  recordHeartbeat() / workerIsHealthy(): the deep health check's one row
    src/migrations-status.ts  pendingMigrations(): the bundled drizzle journal vs drizzle.__drizzle_migrations
```

## Schema changes

- **Schema changes:** edit `packages/db/src/schema.ts`, then `pnpm db:generate` and commit the new SQL in
  `packages/db/drizzle/`. Never edit a migration that has been applied. Only web's pre-deploy step
  applies migrations; the worker bundles the journal and waits for them (Worker jobs).

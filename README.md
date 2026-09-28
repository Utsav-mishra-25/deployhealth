# deployhealth

Most outages after a deploy aren't exotic. A new env var that nobody set, a secret renamed in
code but not in `.env.example`, a config value that quietly drifted. deployhealth puts those two
signals side by side on one timeline per project:

- **Config health.** A GitHub Action scans each commit for env vars that are referenced but
  never defined, defined but never used, or out of sync between `.env` and `.env.example`.
- **Uptime.** A worker checks your endpoints (Phase 2).

When a deploy is followed by failures, the dashboard shows exactly which variables that deploy
newly broke.

## Screenshots

**Phase 1: config health**

> _Screenshot placeholder: project page with the latest scan summary, findings grouped by kind
> (file:line), and the deploy history._

> _Screenshot placeholder: creating a project, with the one-time token and the GitHub Action
> snippet._

**Phase 2: uptime and correlation**

> _Screenshot placeholder: timeline with deploys, check latency and alerts linked to deploys._

## Local setup

You need Node 22.12+, pnpm 10 (`corepack enable`) and Docker.

```sh
pnpm install
docker compose up -d                              # Postgres 16 on localhost:5432

cp apps/web/.env.example apps/web/.env.local      # set AUTH_SECRET: openssl rand -base64 32
cp apps/worker/.env.example apps/worker/.env
cp packages/db/.env.example packages/db/.env

pnpm db:migrate
pnpm db:seed                                      # demo user, 1 project, 10 deploys; prints a token
pnpm dev                                          # web on http://localhost:3000, plus the worker
```

Open http://localhost:3000 and choose **Continue with the demo account**. This option exists
only when `AUTH_DEMO_LOGIN=1` and the app is not running in production. To sign in with GitHub
locally instead, create a GitHub OAuth app with callback URL
`http://localhost:3000/api/auth/callback/github` and set `AUTH_GITHUB_ID` and
`AUTH_GITHUB_SECRET` in `apps/web/.env.local`.

Tests: `pnpm test` (unit, needs the Postgres from docker compose) and `pnpm e2e` (Playwright
smoke test). See [CLAUDE.md](CLAUDE.md) for details.

## Deploy to Railway

The repo defines two Railway services, **web** and **worker**, plus Railway's Postgres.

1. Create a Railway project and add **PostgreSQL**.
2. Add a service from this GitHub repo and name it `web`. In its settings:
   - *Config-as-code path*: `apps/web/railway.json`. Leave the root directory as the repo root,
     because the build needs the whole workspace.
   - *Variables*:
     - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
     - `AUTH_SECRET` = output of `openssl rand -base64 32`
     - `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` from a GitHub OAuth app whose callback URL is
       `https://<your-web-domain>/api/auth/callback/github`
   - *Networking*: generate a public domain.
3. Add a second service from the same repo and name it `worker`:
   - *Config-as-code path*: `apps/worker/railway.json`
   - *Variables*: `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
4. Deploy. The web service runs the database migrations as its pre-deploy step
   (`node packages/db/dist/migrate.js`) and is health-checked at `/api/health`. The worker starts
   pg-boss, which creates its own `pgboss` schema.

Railway picks Node 22 from `.nvmrc` / `engines`, and pnpm from the `packageManager` field.
Never set `AUTH_DEMO_LOGIN` in production. Even if you did, the demo provider is not
registered when `NODE_ENV=production`.

## How it works

### Ingest flow

```
GitHub push ─▶ Action ─▶ deployhealth-scan (runs in CI) ─▶ POST /api/ingest/scan ─▶ Postgres ─▶ dashboard
```

1. **Create a project.** You get an ingest token (`dh_…`, shown once; only its SHA-256 is stored)
   and a workflow snippet. Save the token as the repo secret `DEPLOYHEALTH_TOKEN` and commit the
   snippet as `.github/workflows/deployhealth.yml`.
2. **On every push**, the Action downloads the CLI from your deployhealth instance
   (`/deployhealth-scan.mjs`, a single 11 KB file with no dependencies, so nothing is installed
   from npm) and runs it in the checkout with the commit sha and branch.
3. **The scanner** walks the repo (respecting `.gitignore`; skipping `node_modules`, `dist`,
   `.git`, `.next` and virtualenvs). It finds env var references in JS/TS
   (`process.env.X`, `process.env["X"]`, `import.meta.env.X`), Python (`os.environ["X"]`,
   `os.environ.get("X")`, `os.getenv("X")`), Go (`os.Getenv("X")`, `os.LookupEnv("X")`) and Ruby
   (`ENV["X"]`, `ENV.fetch("X")`). It reads `.env`, `.env.example` and `.env.local`, even when
   they are gitignored.
   - **Env scopes (monorepos).** Every directory containing an env file is a scope. Each source
     file is checked against its nearest scope, so `apps/web/src/x.ts` is compared with
     `apps/web/.env.example`, not with another package's.
   - Findings are **MISSING** (referenced, not defined in the scope), **UNUSED** (defined, never
     referenced) and **MISMATCH** (in `.env` but not `.env.example`, or the reverse), each with
     `file:line`.
4. **The CLI posts** `{ sha, branch, timestamp, findings[] }` with `Authorization: Bearer <token>`.
5. **The server** authenticates the token first (by hash), then validates the payload with the
   same schema the CLI was built against. In one transaction it creates the **deploy** for that
   sha, or reuses it if CI re-runs; stores a **scan** with counts it computes itself (distinct
   variables per kind); and stores every **finding**.
6. **The project page** shows the latest scan's counts, findings grouped by kind with
   `file:line`, and the deploy history. Click any deploy to see its findings.

Run the scanner without sending anything: `node deployhealth-scan.mjs --dry-run` (add `--json`,
`--ignore NAME_*`, `--exclude path/`).

### Correlation rule (Phase 2)

The worker checks each endpoint on its interval and records status and latency. An alert is
raised when **both** of these hold:

- the endpoint has recorded **at least one ok check** (a URL that has never worked doesn't alert), and
- it then fails **2 consecutive checks**.

The alert is linked to the **most recent deploy in the 30 minutes before the first failure**, if
there is one. Its message compares that deploy's scan with the **previous deploy's scan for the
same project** and lists only the MISSING variables that are **new** in this deploy. If there
are none, the message says the deploy had no new findings. Either way, it points you straight to
what changed.

## Repository layout

`apps/web` (Next.js), `apps/worker` (pg-boss), `packages/core` (scanner, CLI, shared contract),
`packages/db` (Drizzle schema, migrations, queries, seed). See [CLAUDE.md](CLAUDE.md) for the
full map and conventions.

# deployhealth

**One page for every client project you maintain: is the config sane, is it up, and did the
last deploy break it.**

If you look after a dozen client sites and APIs, most bad deploys fail the same boring way: a new
env var nobody set, a secret renamed in code but not in `.env.example`. deployhealth groups your
projects by client and puts two signals on each one:

- **Config health.** A GitHub Action scans every push for env vars that are referenced but never
  defined, defined but never used, or out of sync between `.env` and `.env.example`.
- **Uptime.** A worker checks your health endpoints every 1, 5 or 15 minutes.

When an endpoint goes down shortly after a deploy, the alert names the deploy and the variables
it newly left undefined:

> api.acme.com started failing 4m after deploy b52952e, which introduced 2 missing env vars:
> REDIS_URL, STRIPE_KEY

## Screenshots

**Phase 1: config health**

> _Screenshot placeholder: project page with the latest scan summary, findings grouped by kind
> (file:line) and the deploy history._

> _Screenshot placeholder: creating a project, with the one-time token and the GitHub Action
> snippet._

**Phase 2: clients, uptime and alerts**

> _Screenshot placeholder: /clients, every client with its projects, findings badges, last deploy
> and uptime badge ("Down for 22m")._

> _Screenshot placeholder: project page with the open-alert banner, endpoint uptime, p50/p95
> latency chart and recent checks._

## Phases

| Phase | Status | What it adds |
| --- | --- | --- |
| 1. Config health | Done | GitHub Action + CLI, ingest API, findings per deploy, project pages, GitHub login |
| 2. Clients, uptime and alerts | Done | Clients, uptime checks from a worker, alerts linked to deploys, Slack/Discord webhooks |
| Next | Ideas | See [Known limitations](#known-limitations) for what's deliberately missing |

## Local setup

You need Node 22.12+, pnpm 10 (`corepack enable`) and Docker.

```sh
pnpm install
docker compose up -d                              # Postgres 16 on localhost:5432

cp apps/web/.env.example apps/web/.env.local      # set AUTH_SECRET: openssl rand -base64 32
cp apps/worker/.env.example apps/worker/.env
cp packages/db/.env.example packages/db/.env

pnpm db:migrate
pnpm db:seed                                      # demo data (below); prints an ingest token
pnpm dev                                          # web on http://localhost:3000, plus the worker
```

Open http://localhost:3000 and choose **Continue with the demo account**. This option exists only
when `AUTH_DEMO_LOGIN=1` and the app is not running in production. To sign in with GitHub instead,
create a GitHub OAuth app with callback URL `http://localhost:3000/api/auth/callback/github` and
set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` in `apps/web/.env.local`.

The seed creates two clients (Acme Corp, Northwind Bakery) and three projects, one without a
client. Four endpoints come with a week of checks. One is scripted: acme-storefront's last deploy
introduces two undefined variables, its API starts failing four minutes later, and an open alert
links the two. Healthy seeded endpoints point at `example.com`/`.org`/`.net` so a running worker
keeps them green; the failing one uses `api.acme.example`, which never resolves.

Tests: `pnpm test` (unit; needs the Postgres from docker compose) and `pnpm e2e` (Playwright
smoke test). See [CLAUDE.md](CLAUDE.md) for details.

## Deploy to Railway

deployhealth runs as three Railway services: **Postgres**, **web** and **worker**. Build, deploy
and health-check settings are in `apps/web/railway.json` and `apps/worker/railway.json`. Both
services build from the repo root (it's a pnpm workspace), and web applies database migrations in
its pre-deploy step. The dashboard steps, every variable and troubleshooting are in
[docs/deploy-railway.md](docs/deploy-railway.md).

## How it works

### Config: the ingest flow

```
git push ─▶ GitHub Action ─▶ deployhealth-scan (in CI) ─▶ POST /api/ingest/scan ─▶ Postgres ─▶ dashboard
```

1. **Create a project** (optionally under a client). You get an ingest token (`dh_…`, shown once;
   only its SHA-256 is stored) and a workflow snippet. Save the token as the repo secret
   `DEPLOYHEALTH_TOKEN` and commit the snippet as `.github/workflows/deployhealth.yml`.
2. **On every push**, the Action downloads the CLI from your deployhealth instance
   (`/deployhealth-scan.mjs`, one 11 KB file with no dependencies) and runs it on the checkout with
   the commit sha and branch.
3. **The scanner** walks the repo, respecting `.gitignore` and skipping `node_modules`, `dist`,
   `.git`, `.next` and virtualenvs. It finds references in JS/TS (`process.env.X`,
   `process.env["X"]`, `import.meta.env.X`), Python (`os.environ["X"]`, `os.environ.get("X")`,
   `os.getenv("X")`), Go (`os.Getenv("X")`, `os.LookupEnv("X")`) and Ruby (`ENV["X"]`,
   `ENV.fetch("X")`), and reads `.env`, `.env.example` and `.env.local`.
   - **Env scopes (monorepos).** Every directory with an env file is a scope, and each source file
     is checked against its nearest one. So `apps/web/src/x.ts` is compared with
     `apps/web/.env.example`, not with another package's.
   - Findings are **MISSING** (referenced, not defined in the scope), **UNUSED** (defined, never
     referenced) and **MISMATCH** (in `.env` but not `.env.example`, or the reverse), each with
     `file:line`.
4. **The CLI posts** `{ sha, branch, timestamp, findings[] }` with `Authorization: Bearer <token>`.
5. **The server** checks the token (by hash) before reading the body, validates the payload with
   the schema the CLI was built against, then in one transaction:
   - creates the **deploy** for that sha, or reuses it when CI re-runs;
   - stores a **scan** with counts it computes itself;
   - stores every **finding**.

Try the scanner locally: `node deployhealth-scan.mjs --dry-run` (add `--json`, `--ignore NAME_*`,
`--exclude path/`).

### Uptime: the worker

- **`check-endpoints`** runs every minute on pg-boss (singleton, so runs never overlap). One
  statement claims every enabled endpoint whose `next_check_at` has passed and moves it forward
  by its interval (`FOR UPDATE SKIP LOCKED`, so two workers never double-check). Claimed
  endpoints are then checked, up to 10 at a time.
- **A check** is one request (GET or HEAD) with a 10 s budget that follows up to 5 redirects. It's
  ok when the final status equals the expected status (default 200). Timeouts, DNS failures, TLS
  errors, refused connections and wrong statuses are recorded as failures with a short reason.
  Response bodies are never read.
- **`prune-checks`** runs nightly (03:17 UTC) and deletes checks older than 30 days.

### Alerts and the correlation rule

After every check, the worker applies one rule in the same transaction that records the check:

- **Open** an alert when an endpoint has failed **2 checks in a row** and has **at least one ok
  check in its history**. A URL that has never worked doesn't alert. There's at most one open
  alert per endpoint (enforced by a unique index).
- **Resolve** it on the endpoint's next ok check.

While an endpoint is failing, its card and its project's row on /clients say for how long
("Down for 21m"), counted from the first failed check of the current run.

When an alert opens, deployhealth finds the project's **most recent deploy in the 30 minutes
before the first failed check**. It then compares that deploy's latest scan with the previous
deploy's latest scan, and the message lists only MISSING variables that are **new** in this
deploy:

- `api.acme.com started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY`
- `api.acme.com started failing 4m after deploy b52952e, which had no new config findings`
- `api.acme.com started failing; no deploy in the 30 minutes before the first failure`

If the project has an **alert webhook URL** (Slack incoming webhook, or Discord's with `/slack`
appended), deployhealth POSTs `{"text": "…"}` when the alert opens and again when it resolves. A
failed delivery is logged and retried at most once.

### SSRF protection

Endpoint and webhook URLs are user input, so they're checked twice:

- **On save:** only http/https, no credentials, and the host must not be (or resolve to) loopback,
  RFC1918, link-local, cloud metadata (`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`),
  CGNAT, multicast or reserved addresses.
- **At connect time:** a guarded DNS lookup repeats the check on the address the socket is about to
  use. That covers every redirect hop and DNS rebinding.

## Known limitations

- **The CLI download isn't pinned.** The Action fetches `/deployhealth-scan.mjs` from your instance
  on every run, with no version or checksum. Whoever controls that instance controls what runs in
  your CI. To avoid it, vendor the file into the repo or check a SHA-256 before running it.
- **MISMATCH needs a committed `.env`, or a platform integration.** CI checkouts rarely contain a
  `.env`, so MISMATCH only appears for repos that commit one (e.g. non-secret defaults). Comparing
  against the real variables on Vercel, Railway or Fly would need a platform integration; there
  isn't one yet.
- **Deploy time means scan time.** A deploy's time is when CI reported it, not when your platform
  finished rolling it out. If the rollout lags the push by more than 30 minutes, the alert won't
  link it.
- **One vantage point.** Checks come from wherever the worker runs (one Railway region). A network
  problem between that region and your endpoint looks like downtime; the 2-failure threshold
  softens this but doesn't remove it.
- **Minute resolution.** Intervals are 1, 5 or 15 minutes, and a check can run up to a minute late.
  Uptime is shown for 24 hours and 7 days, and history is kept for 30 days.
- **Regex scanning.** References inside comments and strings count; aliased or destructured access
  (`const { X } = process.env`) is missed; only `.env`, `.env.example` and `.env.local` are read
  automatically.
- **Notifications** are webhook-only (no email or SMS), and each account is single-user (no team
  sharing).

## Repository layout

`apps/web` (Next.js), `apps/worker` (pg-boss), `packages/core` (scanner, CLI, SSRF guard, alert
rules), `packages/db` (Drizzle schema, migrations, queries, seed). See [CLAUDE.md](CLAUDE.md) for
the full map and conventions.

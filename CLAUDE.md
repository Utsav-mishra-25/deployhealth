# CLAUDE.md

deployhealth is one page for every client project a freelancer maintains: is the config sane (env
var drift between code and env files), is it up (uptime checks), and did the last deploy break it
(alerts linked to the deploy that introduced new missing variables).

Phase 1 (config health) and Phase 2 (clients, uptime, alerts) are built.

## Monorepo layout

```
apps/
  web/                Next.js 15 App Router + Tailwind. UI, Auth.js, POST /api/ingest/scan
    src/env.ts        the ONLY place web reads process.env (by name, validated lazily)
    src/auth.ts       Auth.js v5: GitHub OAuth + dev-only demo login, JWT sessions, no adapter
    src/lib/          ingest handler, form validation (zod), db accessor, auth providers, formatting
    src/app/          /login, /clients (home), /clients/new, /clients/[slug](/edit),
                      /projects/new, /projects/[id] (+ endpoint actions), /projects/[id]/settings
    src/components/   badges, breadcrumb, endpoints section, latency chart (Recharts, client-only)
    e2e/              Playwright smoke test (login → clients → client + project → endpoint)
    railway.json      Railway service config (build, pre-deploy migration, healthcheck)
  worker/             plain Node process running pg-boss
    src/index.ts      queues + schedules: check-endpoints every minute, prune-checks nightly
    src/jobs.ts       job logic with injected deps (claim → check → record → webhook; prune)
    src/check.ts      runCheck(): 10s budget, ≤5 redirects, no bodies; guardedRequest on node:http(s)
    src/webhook.ts    POST {text}, 5s timeout, at most one retry, SSRF-guarded
    src/env.ts        the ONLY place the worker reads process.env
    railway.json
packages/
  core/               scanner + shared contract, no framework deps
    src/scan.ts       scanProject(): walks the repo, env scopes, findings rows
    src/scanner.ts    per-language regexes (JS/TS, Python, Go, Ruby)
    src/findings.ts   analyzeScope() / summarize(): MISSING, UNUSED, MISMATCH
    src/ingest.ts     zod payload schema, token generate/hash/hint, GitHub Action snippet
    src/cli.ts        deployhealth-scan (bundled by tsup into one 11 KB file, served by web)
    src/ssrf.ts       SSRF guard: assertPublicUrl() on save, guardedLookup at connect time
    src/alerts.ts     decideAlert() state machine, alert messages, webhook payload, uptimeStatus()
    src/browser.ts    `@deployhealth/core/browser`: types, constants, alert helpers for client components
  db/                 Drizzle schema, migrations (drizzle/), queries, seed
    src/schema.ts     users, clients, projects, deploys, scans, findings, endpoints, checks, alerts
    src/queries.ts    users, projects, ingest (recordScan), deploys/scans reads
    src/clients.ts    clients CRUD, /clients overview, project↔client assignment
    src/monitoring.ts endpoints CRUD, claimDueEndpoints(), recordCheck() (+ alert lifecycle), stats, prune
    src/seed.ts       demo user, 2 clients, 3 projects, endpoints, 7 days of checks, scripted alert
docker-compose.yml    Postgres 16 (creates deployhealth and deployhealth_test)
.github/workflows/ci.yml   typecheck, lint, unit tests, build
docs/deploy-railway.md     Railway dashboard steps and every variable (root directory stays empty)
```

Workspace packages ship TypeScript source (`exports` → `src/*.ts`). Next transpiles them
(`transpilePackages`); the worker and the CLI are bundled with tsup; tests run them via Vitest.

## Run it locally

Prerequisites: Node >= 22.12 (pg-boss 12 needs it), pnpm 10 (`corepack enable`), Docker.

```sh
pnpm install
docker compose up -d                                    # Postgres on :5432

cp apps/web/.env.example apps/web/.env.local            # then set AUTH_SECRET (openssl rand -base64 32)
cp apps/worker/.env.example apps/worker/.env
cp packages/db/.env.example packages/db/.env

pnpm db:migrate                                         # apply drizzle/ migrations
pnpm db:seed                                            # demo data; prints an ingest token
pnpm dev                                                # web on http://localhost:3000 + worker
```

Sign in with **Continue with the demo account** (needs `AUTH_DEMO_LOGIN=1`, which the example
sets). For GitHub login, create an OAuth app with callback
`http://localhost:3000/api/auth/callback/github` and set `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`.

Run the web app or worker alone with `pnpm --filter @deployhealth/web dev` or
`pnpm --filter @deployhealth/worker dev`.

## Seeding

`pnpm db:seed` deletes the demo user (`github_id = -1`, so it can never match a real GitHub
account) and everything it owns, then recreates:

- clients **Acme Corp** (acme-storefront) and **Northwind Bakery** (northwind-site), plus
  **portfolio** with no client;
- four endpoints with 7 days of checks (deterministic PRNG, daily latency curve, isolated blips);
- the **scripted incident**: acme-storefront's last deploy (b52952e, 26 minutes ago) introduces
  REDIS_URL and STRIPE_KEY; `https://api.acme.example/health` fails from 4 minutes later. Those
  failing checks are replayed through the real `recordCheck()`, so the open alert and its message
  come from production code. A past Northwind incident opens and resolves the same way.

Healthy seeded endpoints use example.com/.org/.net so a running worker keeps them up;
`api.acme.example` never resolves, so the scripted alert stays open. It's safe to re-run and never
touches other users. It prints a fresh ingest token for acme-storefront, so you can post a real scan:

```sh
pnpm --filter @deployhealth/core build
node packages/core/bin/deployhealth-scan.mjs --url http://localhost:3000 --token dh_... \
  --dir packages/core/test/fixtures/project --sha 0123456789abcdef0123456789abcdef01234567 --branch main
```

## Tests and checks

```sh
pnpm test            # all unit tests: core, db (real Postgres), web, worker (all Vitest)
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e             # Playwright smoke test (see below)
pnpm scan:self       # run deployhealth's own scanner on this repo; must report nothing
```

- One file: `pnpm --filter @deployhealth/core exec vitest run test/scan.test.ts`.
- **db tests** use `TEST_DATABASE_URL` (default `.../deployhealth_test`). Global setup drops and
  re-migrates that database's schema on every run, so never point it at real data.
- **e2e** re-seeds the database in `apps/web/.env.local`, starts `next dev` on :3100 with the demo
  login on, and runs login → /clients → create client → create project for it → report a scan →
  add an endpoint ("No checks yet"; no worker needed) → SSRF rejection. First time:
  `pnpm --filter @deployhealth/web exec playwright install chromium` (or set
  `PLAYWRIGHT_CHROMIUM_PATH` to an existing Chromium).
- CI runs typecheck, lint, unit tests and build. Playwright is not in CI.

## Working conventions

- **Plan first.** Before writing code for a phase or a larger change, show the file structure
  (and any schema changes) and wait for a go-ahead.
- **Small conventional commits**, one per logical unit, made as you go: `feat:`, `fix:`, `test:`,
  `docs:`, `chore:`, `ci:` (optionally scoped, e.g. `feat(web):`).
- **No attribution trailers** in commit messages (no `Co-Authored-By:`, no `Claude-Session:`).
- **Do not push.** The maintainer reviews and pushes.
- **Test as you go.** Run the relevant test file after each change; run the full suite
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus `pnpm e2e`) at the end of each phase.
- **End each phase with a short summary:** what's done, what's stubbed, and which decisions need review.

## Code conventions

- **Env vars:** each app reads `process.env` only in its `env.ts`, and by name
  (`DATABASE_URL: process.env.DATABASE_URL`), never by spreading `process.env`. That keeps
  `pnpm scan:self` meaningful. Every variable must appear in that app's `.env.example`.
  Runtime-provided ones (currently only `NODE_ENV`) go in the self-scan's `--ignore` list.
- **Authorization:** every read or write of clients, projects, endpoints, checks and alerts goes
  through a query that takes the signed-in user's id and filters on it (`getProjectForOwner`,
  `getClientBySlug(db, userId, …)`, `updateEndpoint(db, ownerId, …)`, …). Assigning a project to
  a client also checks the client belongs to the same user. `test/isolation.test.ts` asserts that
  user A can't read or modify user B's data; extend it with every new query. Route params are
  checked with `isUuid()` before they reach a uuid column.
- **SSRF:** any URL the server or worker will fetch (endpoints, webhooks) must pass
  `assertPublicUrl()` when saved, and must be fetched through `guardedLookup` (via
  `guardedRequest` / `guardedPost`), never plain `fetch`. The guard re-checks the resolved
  address at connect time, which covers redirects and DNS rebinding.
- **Tokens:** `dh_` + 32 random bytes. Only the SHA-256 is stored, plus a `dh_…abcd` hint. The
  plaintext is shown once, on creation or regeneration.
- **Ingest:** authenticate first, then read the body (5 MB cap), validate with the zod schema from
  `@deployhealth/core`, and store through `recordScan()`, which computes counts server-side. A
  re-reported sha adds a scan to the existing deploy.
- **Client components** import only from `@deployhealth/core/browser` (the main entry pulls in
  `node:fs` / `node:crypto`). Type-only imports from the main entry are fine.
- **The demo login** is registered only when `AUTH_DEMO_LOGIN=1` **and** `NODE_ENV !== 'production'`
  (`lib/auth-providers.ts`; asserted in `test/auth-providers.test.ts`). Don't add other gates
  elsewhere; keep it in that one function.
- **Schema changes:** edit `packages/db/src/schema.ts`, then `pnpm db:generate` and commit the new SQL in
  `packages/db/drizzle/`. Never edit a migration that has been applied.
- **Worker jobs** live in `apps/worker/src/jobs.ts` as plain functions with injected dependencies,
  so they're unit-tested without pg-boss. `index.ts` only wires queues, schedules and real deps.
  Both queues use the `singleton` policy. Checks are scheduled per endpoint via `next_check_at`,
  never with a cron per endpoint.
- **Scanner fixture:** `packages/core/test/fixtures/project` is deliberately broken and must stay
  in sync with the expectations in `test/scan.test.ts`. Its `.env` files are committed through
  negations in the root `.gitignore`. Decoys (node_modules, dist, .git, …) are written into a temp
  copy at test time rather than committed.

## Worker jobs

- **check-endpoints** (every minute): `claimDueEndpoints()` claims enabled endpoints with
  `next_check_at <= now` and moves them forward by their interval in one statement
  (`FOR UPDATE SKIP LOCKED`). It checks up to 10 at a time with `runCheck()`, stores each result
  with `recordCheck()`, and sends webhooks for alert events after the transaction commits.
- **prune-checks** (nightly, 03:17 UTC): deletes checks older than 30 days (BRIN index on
  `checked_at`).

## Alert rule

Applied in `recordCheck()` (one transaction per check) via `decideAlert()` in core:

- **Open** when the endpoint has **2 consecutive failures** and **at least one ok check** in its
  history. At most one open alert per endpoint (partial unique index `alerts_one_open_per_endpoint`).
- **Resolve** on the next ok check.
- **Correlation:** link (`related_deploy_id`) the project's most recent deploy in the **30 minutes
  before the first failed check**. Compare that deploy's latest scan with the previous scanned
  deploy's latest scan, and list only the MISSING vars that are **new**. The message is built by
  `alertOpenedMessage()`: "…started failing 4m after deploy b52952e, which introduced 2 missing
  env vars: …", "…which had no new config findings", or "…no deploy in the 30 minutes before the
  first failure".
- **Webhook:** if `projects.alert_webhook_url` is set, POST `{text}` on open and on resolve. Log
  and continue on failure; at most one retry.
- **Down duration:** "Down for 21m" (or "Failing for 1m" before an alert opens) next to endpoint
  and project badges is measured from the first failed check of the current run:
  `failingSinceSql()` in `monitoring.ts` (also used for the alert's first failure), exposed as
  `EndpointMonitoring.failingSince` and `ProjectListItem.failingSince`, and labelled by
  `failingFor()` in core.

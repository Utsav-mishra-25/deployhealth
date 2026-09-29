# CLAUDE.md

deployhealth is one page for every client project a freelancer maintains: is the config sane (env
var drift between code and env files), is it up (uptime checks), and did the last deploy break it
(alerts linked to the deploy that introduced new missing variables).

Phase 1 (config health), Phase 2 (clients, uptime, alerts) and Phase 3 (public demo, handoff
export, monthly client reports) are built.

## Monorepo layout

```
apps/
  web/                Next.js 15 App Router + Tailwind. UI, Auth.js, POST /api/ingest/scan
    src/env.ts        the ONLY place web reads process.env (by name, validated lazily)
    src/auth.ts       Auth.js v5: GitHub OAuth + dev-only dev login, JWT sessions, no adapter
    src/middleware.ts rate limit for /share/* (Node runtime, in memory)
    src/lib/          ingest handler, validation (zod), guard (read-only demo), demo owner, paths,
                      handoff loader, share-link signing, rate limiter, auth providers, formatting
    src/views/        page bodies shared by signed-in and /demo routes: clients overview, client,
                      project, handoff, report (props: ownerId/data, paths, readOnly)
    src/app/          /login, /clients (home), /clients/new, /clients/[slug](/edit, /report),
                      /projects/new, /projects/[id] (+ endpoint actions, /settings, /handoff,
                      /handoff.md), /demo/... (read-only mirror), /share/reports/[token],
                      /api/demo/broken
    src/components/   badges, breadcrumb, endpoints section, latency chart (Recharts, client-only),
                      SafeMarkdown, demo banner, print/share buttons, report toolbar
    e2e/              Playwright: public demo (+ handoff, report) and the signed-in flow (+ share link)
    railway.json      documentation only: the Railway build/deploy fields set by hand in the dashboard
  worker/             plain Node process running pg-boss
    src/index.ts      queues + schedules: check-endpoints, prune-checks, reseed-demo
    src/jobs.ts       job logic with injected deps (claim → check → record → webhook; rollup → prune; reseed)
    src/check.ts      runCheck(): 10s budget, ≤5 redirects, no bodies; guardedRequest on node:http(s)
    src/webhook.ts    POST {text}, 5s timeout, at most one retry, SSRF-guarded
    src/env.ts        the ONLY place the worker reads process.env
    railway.json      documentation only, like web's
packages/
  core/               scanner + shared contract, no framework deps
    src/scan.ts       scanProject(): walks the repo, env scopes, findings rows
    src/scanner.ts    per-language regexes (JS/TS, Python, Go, Ruby)
    src/findings.ts   analyzeScope() / summarize(): MISSING, UNUSED, MISMATCH
    src/ingest.ts     zod payload schema, token generate/hash/hint, GitHub Action snippet
    src/cli.ts        deployhealth-scan (bundled by tsup into one 11 KB file, served by web)
    src/ssrf.ts       SSRF guard: assertPublicUrl() on save, guardedLookup at connect time
    src/alerts.ts     decideAlert() state machine, alert messages, endpointLabel(), failingFor()
    src/format.ts     formatUtc(), formatPercent() (rounds down), formatInterval(), plural()
    src/handoff.ts    HandoffData, renderHandoffMarkdown(), parseHandoffVariables()
    src/report.ts     report months (UTC), findingsDiff(), ReportData, reportTotals(), summaryLine()
    src/browser.ts    `@deployhealth/core/browser`: the pure subset for client components
  db/                 Drizzle schema, migrations (drizzle/), queries, seed
    src/schema.ts     users, clients, projects, deploys, scans, findings, scan_variables,
                      endpoints, checks, endpoint_daily_stats, alerts
    src/queries.ts    users, projects, ingest (recordScan + variables), deploys/scans reads
    src/clients.ts    clients CRUD, /clients overview, project settings (client, webhook, deploy notes)
    src/monitoring.ts endpoints CRUD, claimDueEndpoints(), recordCheck() (+ alert lifecycle), stats,
                      uptimeBetween() (rollups + raw), rollupChecks(), prune
    src/handoff.ts    getHandoffData() (owner-scoped)
    src/reports.ts    getClientReport() (by client id; see Authorization)
    src/demo.ts       demo user (-1, read-only) and dev user (-2), fixed demo project ids
    src/seed.ts       the demo: 2 clients, 3 projects, named endpoints, 7 days of checks, scripted alert
    src/seed-cli.ts   `pnpm db:seed` (kept apart so importing the seed runs nothing)
docker-compose.yml    Postgres 16 (creates deployhealth and deployhealth_test)
LICENSE               FSL-1.1-MIT (everything except packages/core, which has its own MIT LICENSE)
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

Open http://localhost:3000/demo for the seeded demo (read-only, `DEMO_PUBLIC=1` in the example).
Sign in with **Continue as dev user** (needs `AUTH_DEMO_LOGIN=1`, which the example sets) to create
and edit your own data as the local `dev` user. For GitHub login, create an OAuth app with callback
`http://localhost:3000/api/auth/callback/github` and set `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`.

Run the web app or worker alone with `pnpm --filter @deployhealth/web dev` or
`pnpm --filter @deployhealth/worker dev`.

## Seeding

`pnpm db:seed` (`src/seed-cli.ts`) replaces the demo user (`github_id = -1`, so it can never
match a real GitHub account) and everything it owns, in **one transaction**, with:

- clients **Acme Corp** (acme-storefront) and **Northwind Bakery** (northwind-site), plus
  **portfolio** with no client. The projects have **fixed ids** (`DEMO_PROJECT_IDS`), so
  `/demo/projects/<id>` links survive reseeds;
- four endpoints, three **named** ("Acme API", "Acme storefront", "Northwind site"; portfolio's is
  unnamed to show the host fallback), with 7 days of checks (deterministic PRNG);
- every deploy's scan with **variables** consistent with its MISSING findings, and deploy notes for
  two projects (handoff demo);
- the **scripted incident**: acme-storefront's last deploy (b52952e, 26 minutes ago) introduces
  REDIS_URL and STRIPE_KEY; "Acme API" (`<DEMO_BASE_URL>/api/demo/broken`, always 503) fails from
  4 minutes later. Those failing checks are replayed through the real `recordCheck()`, so the open
  alert ("Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars:
  REDIS_URL, STRIPE_KEY") comes from production code and reads the same on every reseed. A past
  Northwind incident opens and resolves the same way.

`DEMO_BASE_URL` (packages/db `.env`, default `http://localhost:3000`) is the web app's public URL.
Locally the worker's SSRF guard blocks localhost, so Acme API keeps failing either way. The seed
never touches other users. The CLI prints a fresh ingest token for acme-storefront, so you can post
a real scan (the worker's `reseed-demo` job never prints it):

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
- **e2e** re-seeds the database in `apps/web/.env.local`, starts `next dev` on :3100 with the dev
  login and the demo on, and runs two tests: the public demo without a session (overview → project
  → handoff page and `.md` download → monthly report), and the signed-in flow as the dev user
  (client → project → scan with variables → named endpoint → SSRF rejection → untrusted deploy
  notes in the handoff → share a report → open the link in a fresh context → tampered link 404s).
  First time:
  `pnpm --filter @deployhealth/web exec playwright install chromium` (or set
  `PLAYWRIGHT_CHROMIUM_PATH` to an existing Chromium).
- CI runs typecheck, lint, unit tests and build. Playwright is not in CI.

## Working conventions

- **Plan first.** Before writing code for a phase or a larger change, show the file structure
  (and any schema changes) and wait for a go-ahead.
- **Small conventional commits**, one per logical unit, made as you go: `feat:`, `fix:`, `test:`,
  `docs:`, `chore:`, `ci:` (optionally scoped, e.g. `feat(web):`).
- **No attribution trailers** in commit messages (no `Co-Authored-By:`, no `Claude-Session:`).
- **Push only when asked.** The maintainer reviews; pushes happen at the end of a phase, after the
  full suite is green, when the maintainer says so.
- **Test as you go.** Run the relevant test file after each change; run the full suite
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus `pnpm e2e`) at the end of each phase.
- **End each phase with a short summary:** what's done, what's stubbed, and which decisions need review.

## Code conventions

- **Licensing:** `packages/core` is MIT (its own `LICENSE`, `"license": "MIT"`); everything else is
  FSL-1.1-MIT (root `LICENSE`, `"license": "FSL-1.1-MIT"` in the root, apps and `packages/db`).
  Moving code into `packages/core` relicenses it as MIT, so only move what the CLI or scanner needs.
  A new package sets its `license` field.
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
  - **One exception: `getClientReport(db, clientId, …)`** isn't owner-scoped, because a signed share
    link reaches it with only a client id. It reads strictly by that client id, and only projects
    owned by the client's own user. Owner routes must find the client with
    `getClientBySlug(db, userId, slug)` first. `test/reports.test.ts` checks client A's report never
    contains client B's data.
- **Read-only demo:** every server action calls `requireWritableUser()` (`lib/guard.ts`) first,
  before touching its arguments or the database. It throws `ReadOnlyDemoError` for the demo user,
  whatever route the request came from. `test/guard.test.ts` finds every exported function in every
  `'use server'` module and calls it as the demo user, with every db function trapped; it also pins
  the list of files with inline server actions (sign-in/out only). New actions are covered
  automatically, but they must start with `requireWritableUser()`, and a `'use server'` module may
  export only async functions.
- **Demo mode:** `DEMO_PUBLIC=1` serves `/demo/...` from the same views as the signed-in pages
  (`src/views/`, `readOnly` + `DEMO_PATHS`), with no session: pages call `demoOwner()` (404 when the
  flag is off or the demo isn't seeded), route handlers `findDemoOwner()`. `test/demo.test.ts`
  checks every file under `app/demo` does, and none touches `@/auth`. `/api/demo/broken` is the
  demo's failing endpoint (503, no body) and 404s with the flag off.
- **Endpoint names:** optional, at most 60 characters. `endpointLabel({ url, name })` in core is the
  only way to name an endpoint in messages, badges, rows and webhooks: the name, else the host.
  Alert messages store the label at the time they open; renames don't rewrite history.
- **Share links:** `lib/share-link.ts`. Token = base64url(`v1.<clientId>.<YYYY-MM>.<expiry>`) + `.` +
  base64url(HMAC-SHA256). The key is `REPORT_SHARE_SECRET`, else HKDF-SHA256 of `AUTH_SECRET` with
  info `deployhealth-report-share`. Verify the signature (constant time) before parsing fields.
  Stateless, 90 days; rotating the key revokes every link. `/share/*` is rate-limited per IP in
  `middleware.ts` (Node runtime, 30/min, keyed on the last `X-Forwarded-For` hop).
- **Untrusted Markdown** (deploy notes) renders only through `SafeMarkdown`: react-markdown with
  `skipHtml`, images removed, external links `rel="noopener noreferrer"`. Never add rehype-raw.
- **Printable pages** (handoff, report) use print CSS (`print:hidden`, `.doc-section`) and no
  external assets; the browser's Save as PDF is the PDF path. They state "All times UTC".
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
- **The dev login** ("Continue as dev user", provider `dev`, signs in as the writable `dev` user,
  `github_id = -2`) is registered only when `AUTH_DEMO_LOGIN=1` **and** `NODE_ENV !== 'production'`
  (`lib/auth-providers.ts`; asserted in `test/auth-providers.test.ts`). Don't add other gates
  elsewhere; keep it in that one function. It never signs in as the read-only demo user.
- **Schema changes:** edit `packages/db/src/schema.ts`, then `pnpm db:generate` and commit the new SQL in
  `packages/db/drizzle/`. Never edit a migration that has been applied.
- **Worker jobs** live in `apps/worker/src/jobs.ts` as plain functions with injected dependencies,
  so they're unit-tested without pg-boss. `index.ts` only wires queues, schedules and real deps.
  Every queue uses the `singleton` policy. Checks are scheduled per endpoint via `next_check_at`,
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
- **prune-checks** (nightly, 03:17 UTC): first `rollupChecks()` writes one `endpoint_daily_stats`
  row per endpoint per complete UTC day (idempotent upsert), then `pruneChecks()` deletes raw checks
  from whole days more than 30 days back. A failed rollup deletes nothing.
- **reseed-demo** (only with `DEMO_PUBLIC=1`, which also needs `DEMO_BASE_URL`): nightly at 04:41
  UTC and once on start, runs the seed so production needs no manual seed step. Never logs the token.

## Report data model

- **Months are UTC** (`parseMonth('YYYY-MM')` → `[from, to)`). A month in progress counts up to now.
- **Uptime** per endpoint = ok / checks over the month from `uptimeBetween()`: complete days from
  `endpoint_daily_stats`, other days from raw checks. The report's uptime is the average of the
  endpoints that have checks (each endpoint counts once).
- **Incidents** are alerts opened in the month; duration is open → resolve, or → month end / now.
- **Deploys** are the month's deploys; each is diffed (`findingsDiff`, by kind + variable) against
  the previous scanned deploy (including one before the month): introduced and fixed.
- **Open findings** are the latest scan's, as of now.
- `summaryLine(reportTotals(data))` is the plain-English line, pinned by tests in core and db:
  "3 projects, 99.94% uptime, 1 incident (21m), 14 deploys, 2 config issues fixed".

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

# CLAUDE.md

deployhealth is one page for every client project a freelancer maintains: is the config sane (env
var drift between code and env files), is it up (uptime checks), and did the last deploy break it
(alerts linked to the deploy that introduced new missing variables).

Phase 1 (config health), Phase 2 (clients, uptime, alerts), Phase 3 (public demo, handoff
export, monthly client reports), Phase 4 (licensing, the npm CLI, hard caps, /security, and the
GitHub App's env check on every pull request), Phase 4.5 (launch polish: landing page, a demo
that's fresh at any hour, phone layouts, /privacy and /terms, metadata, security headers) and
Phase 4.6 (scanner accuracy on real repos, CLI 0.3.0) are built.

## Monorepo layout

```
apps/
  web/                Next.js 15 App Router + Tailwind. UI, Auth.js, POST /api/ingest/scan
    src/env.ts        the ONLY place web reads process.env (by name, validated lazily)
    src/auth.ts       Auth.js v5: GitHub OAuth + dev-only dev login, JWT sessions, no adapter
    src/middleware.ts rate limit for /share/* (Node runtime, in memory)
    src/lib/          ingest handler, validation (zod), guard (read-only demo), demo owner, paths,
                      handoff loader, share-link signing, rate limiter, auth providers (+ the OAuth
                      scopes and what sign-in reads), formatting, github-webhook.ts (signature,
                      dedupe, per-installation limit, events), jobs.ts (send-only pg-boss client),
                      read-body.ts (capped streaming body reader), legal.ts (operator, hosting,
                      subprocessors, retention wording), titles.ts (page titles), landing.ts, brand.ts
    src/views/        page bodies shared by signed-in and /demo routes: clients overview, client,
                      project, handoff, report (props: ownerId/data, paths, readOnly)
    src/app/          / (landing when signed out, else → /clients), /login, /clients, /clients/new,
                      /clients/[slug](/edit, /report), /projects/new, /projects/[id] (+ endpoint
                      actions, /settings, /handoff, /handoff.md), /demo/... (read-only mirror),
                      /share/reports/[token], /api/demo/broken, /security, /privacy, /terms and
                      /.well-known/security.txt (public), /api/github/webhook (GitHub App),
                      /github/installed (the App's setup URL); icon.svg, opengraph-image.tsx (+
                      twitter-image), sitemap.ts
    src/components/   badges, breadcrumb, endpoints section, latency chart (Recharts, client-only),
                      SafeMarkdown, demo banner, print/share buttons, report toolbar, alert card,
                      landing, prose-page (layout of /security, /privacy, /terms)
    e2e/              Playwright: public demo (+ handoff, report) and the signed-in flow (+ share link)
    railway.json      documentation only: the Railway build/deploy fields set by hand in the dashboard
  worker/             plain Node process running pg-boss
    src/index.ts      wires queues and real deps: check-endpoints, prune-checks, reseed-demo, pr-check
    src/schedules.ts  every queue's options and cron (registerQueues: create, re-apply options, schedule)
    src/jobs.ts       job logic with injected deps (claim → check → record → webhook; rollup → prune; reseed)
    src/check.ts      runCheck(): 10s budget, ≤5 redirects, no bodies
    src/webhook.ts    POST {text}, 5s timeout, at most one retry, SSRF-guarded
    src/guarded-http.ts  the ONLY outbound HTTP: guardedRequest / guardedPost on node:http(s) + guardedLookup,
                      and githubFetch (Octokit's fetch: api.github.com only, keep-alive, response cap)
    src/github/       app.ts (App JWT → installation token via @octokit/auth-app, one client per
                      installation), api.ts (the few GitHub calls a check makes)
    src/pr-check/     build.ts (trees → files → scan, within the caps), diff.ts, secrets.ts,
                      agents.ts, report.ts (conclusion, the comment, the check run)
    src/env.ts        the ONLY place the worker reads process.env
    railway.json      documentation only, like web's
packages/
  core/               scanner + shared contract, no framework deps
    src/scan.ts       scanProject(): walks the repo, env scopes (+ envScopes, defaultIgnored), findings rows
    src/scanner.ts    per-language regexes (JS/TS incl. .mjs/.cjs/.mts/.cts, Python, Go, Ruby),
                      same-line inline defaults (Reference.hasDefault), one reference per name per line
    src/pydantic.ts   pydantic-settings fields as references (Python logical lines, env_prefix, aliases)
    src/compose.ts    Docker Compose files and the names they interpolate (used, never MISSING)
    src/env-files.ts  which file names are env files / declaration files; display order (browser-safe)
    src/vendored.ts   VENDORED_DIRS, generated file names, MAX_SOURCE_FILE_BYTES (512 KB)
    src/findings.ts   analyzeScope() / summarize(): MISSING, UNUSED, MISMATCH; newMissingVars() /
                      newUndeclaredVars() for deploy correlation
    src/default-ignore.ts  DEFAULT_IGNORE: names the platform or runtime provides, skipped by default
    src/ingest.ts     zod payload schema, token generate/hash/hint, GitHub Action snippet
    src/cli.ts        deployhealth-scan (bundled by tsup into one 24 KB file, served by web)
    src/version.ts    CLI_VERSION, printed by --version; equals npm/package.json's version
    npm/              the published npm package `deployhealth-scan`: manifest + README (committed);
                      `build:npm` adds dist/ and LICENSE (gitignored)
    scripts/pack-npm.mjs  assembles npm/ from dist/ and checks the bundle's --version
    src/ssrf.ts       SSRF guard: assertPublicUrl() on save, guardedLookup at connect time
    src/alerts.ts     decideAlert() state machine, alert messages, endpointLabel(), failingFor()
    src/format.ts     formatUtc(), formatPercent() (rounds down), formatInterval(), plural()
    src/handoff.ts    HandoffData, renderHandoffMarkdown(), parseHandoffVariables()
    src/report.ts     report months (UTC), findingsDiff(), ReportData, reportTotals(), summaryLine()
    src/browser.ts    `@deployhealth/core/browser`: the pure subset for client components
  db/                 Drizzle schema, migrations (drizzle/), queries, seed
    src/schema.ts     users, clients, projects, deploys, scans (+ env_scopes), findings, scan_variables (+ optional),
                      endpoints, checks, check_hosts, endpoint_daily_stats, alerts, installations,
                      installation_repos, pr_checks, webhook_deliveries
    src/queries.ts    users, projects, ingest (recordScan + variables), deploys/scans reads
    src/clients.ts    clients CRUD, /clients overview, project settings (client, webhook, deploy notes)
    src/monitoring.ts endpoints CRUD, claimDueEndpoints(), recordCheck() (+ alert lifecycle), stats,
                      uptimeBetween() (rollups + raw), rollupChecks(), prune
    src/handoff.ts    getHandoffData() (owner-scoped)
    src/reports.ts    getClientReport() (by client id; see Authorization)
    src/github.ts     installations, installation repos, webhook deliveries, pr_checks (worker upserts;
                      owner-scoped reads for the UI: status, PR list, agent stats)
    src/demo.ts       demo user (-1, read-only) and dev user (-2), fixed demo project ids
    src/seed.ts       the demo: 2 clients, 3 projects, named endpoints, 7 days of checks, scripted alert
    src/seed-cli.ts   `pnpm db:seed` (kept apart so importing the seed runs nothing)
docker-compose.yml    Postgres 16 (creates deployhealth and deployhealth_test)
LICENSE               FSL-1.1-MIT (everything except packages/core, which has its own MIT LICENSE)
.github/workflows/ci.yml   typecheck, lint, unit tests, build
.github/workflows/deployhealth.yml   dogfood: the published CLI reports this repo on every push to main
.github/workflows/publish-cli.yml    manual: publish deployhealth-scan to npm with provenance
docs/deploy-railway.md     Railway dashboard steps and every variable (root directory stays empty)
scripts/eval-repos.mjs     `pnpm eval:repos`: scanner accuracy on pinned public repos (manual, not in CI)
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

`pnpm db:seed` (`src/seed-cli.ts`) replaces everything the demo user (`github_id = -1`, so it can
never match a real GitHub account) owns, in **one transaction**, with:

- clients **Acme Corp** (acme-storefront) and **Northwind Bakery** (northwind-site), plus
  **portfolio** with no client. The projects have **fixed ids** (`DEMO_PROJECT_IDS`), so
  `/demo/projects/<id>` links survive reseeds;
- four endpoints, three **named** ("Acme API", "Acme storefront", "Northwind site"; portfolio's is
  unnamed to show the host fallback), with 7 days of checks (deterministic PRNG);
- every deploy's scan with **variables** consistent with its MISSING findings, **env scopes**, and
  deploy notes for two projects (handoff demo). **portfolio has no env file**, so its page shows the
  "No .env.example here" notice and its handoff a starting `.env.example`; acme's `PORT` is optional;
- the **scripted incident**: acme-storefront's last deploy (b52952e, 12 minutes ago) introduces
  REDIS_URL and STRIPE_KEY; "Acme API" (`<DEMO_BASE_URL>/api/demo/broken`, always 503) fails from
  4 minutes later. Those failing checks are replayed through the real `recordCheck()`, so the open
  alert ("Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars:
  REDIS_URL, STRIPE_KEY") comes from production code and reads the same on every reseed. A past
  Northwind incident opens and resolves the same way.
- **freshness**: the worker reseeds every 30 minutes, so the incident's deploy is always 12–42
  minutes old and Acme API down for under an hour (`DEMO_FRESHNESS`; tested in the seed and
  against `RESEED_INTERVAL_MINUTES` in the worker). Change one, check the other;
- **sample pull request checks** on acme-storefront: Claude's #87 adds REDIS_URL and STRIPE_KEY
  undeclared (neutral, merged a minute before b52952e), a clean rename (#86), and a committed
  `apps/web/.env.local` with one secret-shaped string (#88, failure), plus a Devin PR on northwind.
  The web app renders demo PR rows without GitHub links, marked "Sample";
- **stable ids across reseeds**: the demo user row is kept (upserted; its clients and projects are
  deleted and recreated), and projects and endpoints have fixed ids (`DEMO_PROJECT_IDS`,
  `DEMO_ENDPOINT_IDS`). A /demo request that resolved the demo owner before a reseed committed
  still finds the same data after it, and never renders empty or 404s. Deploy ids do change, so a
  `?deploy=` that isn't the project's shows the latest deploy.

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
pnpm eval:repos      # manual: counts per repo on pinned public repos (--cli "npx --yes deployhealth-scan@x.y.z" to compare)
```

- One file: `pnpm --filter @deployhealth/core exec vitest run test/scan.test.ts`.
- **db tests** use `TEST_DATABASE_URL` (default `.../deployhealth_test`). Global setup drops and
  re-migrates that database's schema on every run, so never point it at real data.
- **e2e** re-seeds the database in `apps/web/.env.local`, starts `next dev` on :3100 with the dev
  login and the demo on, and runs: the landing page (signed out, one click to the demo); the public
  demo without a session (overview → project with its sample PR checks → handoff page and `.md`
  download → monthly report); portfolio's "No .env.example here" notice → the handoff's starting
  `.env.example` (page and `.md`); the signed-in flow as the dev user (`/` → /clients, client → project
  → scan with variables → named endpoint → SSRF rejection → untrusted deploy notes in the handoff
  → share a report → open the link in a fresh context → tampered link 404s); /privacy and /terms;
  the security headers; and `mobile.spec.ts`, which checks at 375×812 that no public or signed-in
  page (nor a shared report) scrolls sideways.
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
- **Commits are authored by the maintainer:** set git `user.name`/`user.email` to
  `Utsav Mishra <utsav.mishra25@gmail.com>` at the start of a session; no attribution trailers.
- **Push only when asked.** The maintainer reviews; pushes happen at the end of a phase, after the
  full suite is green, when the maintainer says so.
- **Test as you go.** Run the relevant test file after each change; run the full suite
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus `pnpm e2e`) at the end of each phase.
- **End each phase with a short summary:** what's done, what's stubbed, and which decisions need review.

## Code conventions

- **Hard caps** live in `packages/core/src/limits.ts` and hold for every account whatever its plan:
  100 endpoints per project and 500 per user (`createEndpoint`, which locks the owner's row so
  concurrent creates can't race past them), one check per hostname per 10 s across all users (the
  claim, above), 5 MB ingest bodies (counted while streaming), and 2,000 files / 20 MB fetched per
  pull request check (`createFetchBudget()`: `take(size)` before each download, `verify()` after).
  Exceeding one throws `LimitExceededError`, whose message is safe to show.
- **Licensing:** `packages/core` is MIT (its own `LICENSE`, `"license": "MIT"`); everything else is
  FSL-1.1-MIT (root `LICENSE`, `"license": "FSL-1.1-MIT"` in the root, apps and `packages/db`).
  Moving code into `packages/core` relicenses it as MIT, so only move what the CLI or scanner needs.
  A new package sets its `license` field.
- **Env vars:** each app reads `process.env` only in its `env.ts`, and by name
  (`DATABASE_URL: process.env.DATABASE_URL`), never by spreading `process.env`. That keeps
  `pnpm scan:self` meaningful. Every variable must appear in that app's `.env.example`.
  Runtime-provided ones (`NODE_ENV`) are skipped by the scanner's `DEFAULT_IGNORE`, and tests
  and fixtures are skipped by default, so the self-scan needs no `--ignore` or `--exclude`.
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
- **Public pages** (`/`, `/login`, `/demo/...`, `/share/*`, `/security`, `/privacy`, `/terms`): no
  external assets (fonts, scripts, images, analytics), server components unless interactivity is
  unavoidable, and no sideways scroll at 375 px (`e2e/mobile.spec.ts`; wide tables go inside their
  own `overflow-x-auto` box, or `.doc-scroll` on printable pages, which prints full width; long
  names and paths get `break-all`/`break-words`). No new env vars for them without a decision.
- **`/`** is the landing page for signed-out visitors (indexable) and redirects signed-in users to
  /clients. Its example alert is built by `alertOpenedMessage()` with the demo incident's values
  (`lib/landing.ts`, tested against the seed); the demo button shows only with `DEMO_PUBLIC=1`, and
  "Sign in with GitHub" links to /login (no inline server action, so the guard test's list holds).
  "Free while in beta", never prices. The bundle size it states is `CLI_BUNDLE_KB` (core), pinned to
  the built CLI by `test/npm-package.test.ts`.
- **Metadata:** the root layout sets `metadataBase` from `appUrl()` and generic Open Graph / Twitter
  (`summary_large_image`) cards titled "deployhealth" on every page, so link previews never carry a
  client's name. `app/opengraph-image.tsx` (next/og, its bundled font, rendered at build) is the
  preview. Page titles come from `lib/titles.ts`: "<project> · deployhealth", "Handoff · <project>
  · …", "<client> · …", "Report · <Month YYYY> · …", with "Live demo" before the site name on
  /demo; `/share/*` stays "Monthly report · deployhealth" and noindex. `sitemap.ts` lists the
  public pages; there is no robots route (Cloudflare manages robots.txt).
- **Security headers** (`SECURITY_HEADERS` in `next.config.ts`, on `/:path*`, tested with Next's own
  matcher): nosniff, `strict-origin-when-cross-origin`, `X-Frame-Options: DENY` + CSP
  `frame-ancestors 'none'` (the only CSP directive for now: Next's inline scripts need nonces
  first), and a Permissions-Policy denying camera, microphone and geolocation. No HSTS in code: it's
  set at Cloudflare.
- **/security** (public, linked from the footer) states what's stored and how checks and share
  links work, using the shared constants (`CHECK_TIMEOUT_MS`, caps, `SHARE_LINK_DAYS`) so it can't
  drift. Keep it true when behaviour changes (anything new that reads repositories goes there). The
  contact is `SECURITY_CONTACT_EMAIL`, else a private GitHub security advisory; the same contact
  goes into `/.well-known/security.txt` (RFC 9116, `Expires` 180 days out, rounded to the day).
- **/privacy and /terms** are static pages whose facts live in `lib/legal.ts` (operator and
  country, `LEGAL_LAST_UPDATED`, hosting region, subprocessors, deletion window,
  `CHECK_RETENTION_TEXT`) and `lib/auth-providers.ts` (`GITHUB_OAUTH_SCOPES`, `githubSignInReads()`,
  also shown on /login and /security). The contact is `securityContact()`. `test/legal.test.ts`
  checks /privacy and /security render the same retention and scope text. Bump
  `LEGAL_LAST_UPDATED` with any change to either page, and keep /privacy true to the code like
  /security.
- **Untrusted Markdown** (deploy notes) renders only through `SafeMarkdown`: react-markdown with
  `skipHtml`, images removed, external links `rel="noopener noreferrer"`. Never add rehype-raw.
- **Printable pages** (handoff, report) use print CSS (`print:hidden`, `.doc-section`) and no
  external assets; the browser's Save as PDF is the PDF path. They state "All times UTC".
- **SSRF:** any URL the server or worker will fetch (endpoints, webhooks) must pass
  `assertPublicUrl()` when saved, and must be fetched through `apps/worker/src/guarded-http.ts`
  (`guardedRequest` / `guardedPost`, on `guardedLookup`), never plain `fetch`. The guard re-checks
  the resolved address at connect time, which covers redirects and DNS rebinding.
  `apps/worker/test/no-unguarded-http.test.ts` walks the repo and fails if any other non-test file
  contains `fetch(`, `http(s).request(`/`.get(`, axios, undici, `got(`, node-fetch, or imports
  `node:http(s)`/`http2`. Its allowlist names every exception with a reason (the guarded module,
  the CLI, the scanner's Ruby `ENV.fetch` pattern) and fails if an entry goes stale.
- **Tokens:** `dh_` + 32 random bytes. Only the SHA-256 is stored, plus a `dh_…abcd` hint. The
  plaintext is shown once, on creation or regeneration.
- **Ingest:** authenticate first, then read the body (5 MB cap), validate with the zod schema from
  `@deployhealth/core`, and store through `recordScan()`, which computes counts server-side. A
  re-reported sha adds a scan to the existing deploy. Every field a CLI release adds is optional
  (`variables` in 0.1.0; `variables[].optional` and `env_scopes` in 0.2.0), so older payloads keep
  working and are stored as before (`scans.env_scopes` null, nothing optional); zod drops fields it
  doesn't know. Env file names (`defined_in`, `env_files`) must pass `isEnvFileName()` (the fixed
  names plus `.env.<name>.example|sample|template`, 0.3.0), at most 64 per array. Deploy the server
  before publishing a CLI that sends new values (an older server rejects 0.2.0's and 0.3.0's new
  env file names). `test/ingest-handler.test.ts` pins a 0.1.0 payload.
- **The quieter first scan** (core, so the CLI and the GitHub App's PR checks share it):
  `DEFAULT_IGNORE` (exact GitHub Actions names, never a `GITHUB_*` prefix: apps own GITHUB_ names;
  `--no-default-ignore` / `defaultIgnore: false`); a reference with a same-line default (JS `??`/`||`,
  Python a second argument or `or`, Ruby `ENV.fetch` default/block and `ENV[..] ||`; not
  `undefined`/`null`/`None`/`nil`) is never MISSING, and a variable read only that way is
  `optional`; a scope with no env file gets no MISSING rows, only its `EnvScope`, which the project
  page turns into one notice and the handoff into a starting `.env.example`. PR checks count an
  optional variable as declared. **Tests and fixtures** (`test-paths.ts`: `TEST_DIRS` at any depth,
  and `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*_test.py`, `conftest.py`, `*_spec.rb`;
  env files never count as test files) are skipped by `walk`, `selectTreeFiles` (so the App never
  fetches them) and `scanFiles`: no findings, variables or scopes from them; the CLI still reads
  their source so a test-only variable isn't UNUSED. `--include-tests` / `includeTests: true`.
- **Scanner accuracy (0.3.0)**, also in core: **declaration files** (`env-files.ts`: `.env.example`,
  `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults`, `example.env`, `sample.env`,
  `env.example`, `.env.<name>.example|sample|template`) define variables and can be UNUSED; a
  commented `# KEY=` in one declares KEY (never UNUSED); MISMATCH stays `.env` vs `.env.example`;
  PR checks count any declaration file as declaring. **Vendored code** (`vendored.ts`) is never
  read: `VENDORED_DIRS` (not `build`: often build scripts), `.pnp.cjs`/`.pnp.loader.mjs`/`*.min.*`,
  and source files over 512 KB (`stat` in the CLI, blob sizes in `selectTreeFiles`, so the App
  never fetches them); the walk lists committed ones in `vendoredSkipped`/`tooLargeSkipped`.
  **Test tooling** joins `test-paths.ts` (`*.e2e.*`, `*.e2e-spec.*`, `*.cy.*`, runner configs and
  setup files, `playwright/`, `cypress/`, `mocks/`, `__mocks__/`, `testing/`). `scanSource` merges
  repeated reads on a line into one reference (a default only if every read has one), skips a
  match that is a whole quoted string (a bundler `define` key), and reads same-line destructuring
  (`{ <NAME>, <OTHER>: alias, <THIRD> = "x" } = process.env`; a non-nullish default is optional). **pydantic-settings**
  (`pydantic.ts`) fields are references (a `None` default counts only for a type that allows
  None). **Compose interpolation** (`compose.ts`) only marks names used in the file's scope, like
  test files (`usedOutsideCode`): never a reference, a variable or MISSING. Measure changes with
  `pnpm eval:repos` against the published CLI; never commit other projects' variable names.
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
- **Scanner fixtures:** `packages/core/test/fixtures/project` is deliberately broken and must stay
  in sync with the expectations in `test/scan.test.ts`; `fixtures/defaults` covers the quieter
  scan (every default form, the ignore list, the newer extensions and env file names, a scope with
  no env file) for `test/scan-defaults.test.ts`; `fixtures/accuracy` covers 0.3.0 (each declaration
  file name, commented declarations, test tooling, duplicate reads, pydantic-settings, Compose) for
  `test/scan-accuracy.test.ts`, whose vendored directories and >512 KB file are written at test
  time. Their `.env`, `.env.local` and `.env.*.local`
  files are committed through negations in the root `.gitignore`. Decoys (node_modules, dist,
  .git, …) are written into a temp copy at test time rather than committed. The scanner reads
  comments too, so write example code in comments as `process.env.<NAME>`. The fixtures sit under
  `test/`, which the scanner skips by default, but their tests scan the fixture directory itself
  as the root, so the rules apply to paths inside it.

## Releasing the CLI (`deployhealth-scan` on npm)

- The package is `packages/core/npm`, outside the pnpm workspace (MIT, no dependencies, one bin).
  `pnpm --filter @deployhealth/core build:npm` bundles the CLI and fills `npm/dist` and
  `npm/LICENSE`; `test/npm-package.test.ts` checks the manifest, the packed file list and the bin.
- Two versions: `CLI_VERSION` (`src/version.ts`, = `npm/package.json`, what the next publish ships)
  and `PUBLISHED_CLI_VERSION` (`src/constants.ts`, what the Action snippet, the settings page and
  this repo's `.github/workflows/deployhealth.yml` pin). Tests keep each group in sync, and the
  first never behind the second.
- To release: (1) bump `npm/package.json`, `src/version.ts` and the npm README (its workflow block
  must equal `githubActionSnippet({ version: CLI_VERSION })`), push, then publish: `npm publish` in
  `packages/core/npm` from a machine (no provenance), or the manual **Publish CLI** workflow
  (`.github/workflows/publish-cli.yml`), which adds provenance once npm trusted publishing is set up.
  (2) Only once it's on npm, bump `PUBLISHED_CLI_VERSION` and the dogfood workflow.
- Published versions are immutable. Snippets and docs pin an exact version (`npx --yes deployhealth-scan@x.y.z`).
- The generated workflow: push events only (never `pull_request` from forks: it reads a secret),
  job-level `permissions: contents: read`, `persist-credentials: false`, and
  `package-manager-cache: false` on setup-node (v5 otherwise looks for pnpm/yarn and fails). Sha and
  branch come from `$GITHUB_SHA` / `$GITHUB_REF_NAME`, never `${{ }}` inside the script.
- `/deployhealth-scan.mjs` is still served (deprecated, `Deprecation` + `Link` headers from
  `next.config.ts`) for older workflows. Removal is a later phase.

## Worker jobs

- **check-endpoints** (every minute): `claimDueEndpoints()` (one claimer at a time, advisory
  lock) takes enabled endpoints with `next_check_at <= now`, oldest first, at most 5 per hostname,
  and gives each a start time with `assignHostSlots()`: checks of one hostname start at least
  10 s apart **across all users**, on a 10 s grid within the next 50 s. `check_hosts` stores each
  hostname's next free slot; an endpoint that gets no slot stays due and goes first next run. Each
  claimed endpoint's `next_check_at` becomes its start + interval. The job runs the claim in waves
  by start time (never early), up to 10 checks at a time with `runCheck()`, stores each result
  with `recordCheck()`, and sends webhooks for alert events after the transaction commits.
- **prune-checks** (nightly, 03:17 UTC): first `rollupChecks()` writes one `endpoint_daily_stats`
  row per endpoint per complete UTC day (idempotent upsert), then `pruneChecks()` deletes raw checks
  from whole days more than 30 days back. A failed rollup deletes nothing.
- **reseed-demo** (only with `DEMO_PUBLIC=1`, which also needs `DEMO_BASE_URL`): every 30 minutes
  (`RESEED_CRON`) and once on start, runs the seed so production needs no manual seed step and the
  incident stays recent. About a second; logs its duration, never the token. Retries up to 5 times,
  1 → 16 minutes apart, so a start before web has applied a new migration heals itself.
- **Queue options** live in `schedules.ts` (`QUEUES`). pg-boss's `createQueue` ignores an existing
  queue, so `registerQueues()` re-applies every option with `updateQueue` (all but the policy, which
  can't change) on each start.
  The demo also gets a GitHub App installation (`DEMO_INSTALLATION_ID = -1`) and four checked PRs.
- **pr-check** (queued by the web app's GitHub webhook; worked only with the App configured): see
  "GitHub App: pull request checks" below. The nightly prune also deletes webhook delivery ids
  older than 24 h.

## GitHub App: pull request checks

Registered from `docs/github-app-manifest.json` (checks: write, contents: read, metadata: read,
pull_requests: write; events: pull_request; installation events arrive regardless). Web needs
`GITHUB_APP_WEBHOOK_SECRET` and `GITHUB_APP_SLUG`; the worker `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` (base64 PEM). Unset, the webhook 404s and the worker doesn't work the queue.

- **Webhook** (`lib/github-webhook.ts`, unit-tested with injected deps): read the body (5 MB cap,
  counted while streaming) → verify `X-Hub-Signature-256` (HMAC-SHA256, `timingSafeEqual`) → parse →
  rate-limit per installation id (120/min, in memory, 429 + Retry-After) → dedupe by
  `X-GitHub-Delivery` (`webhook_deliveries`, pruned after 24 h; forgotten again if handling fails,
  so a redelivery runs) → dispatch. Installation events are handled inline; `pull_request`
  opened / synchronize / reopened / base-changed queue a `pr-check` job; closed / reopened set
  `pr_checks.closed_at`. No GitHub API calls, 202 fast, and log lines never contain payload data.
- **Linking and mapping.** `installations.installer_github_id` is the delivery's sender; `user_id`
  is set to the user with that GitHub id when the installation arrives or at their next sign-in
  (`linkInstallationsForUser` in the Auth.js `jwt` callback). Never link from the setup URL's query
  string. `findPrCheckTarget` returns only the linked user's project for the repo (case-insensitive,
  oldest if several, installation not suspended); no match → nothing stored, one log line.
- **Queue.** `pr-check` is `stately` with singletonKey `installation:repo#pr`: one running, at most
  one waiting. The job data is only `{ installationId, repoFullName, prNumber }`; the job reads the
  pull request's current head and its **merge base** (compare API) when it runs.
- **Auth.** `createGithubApp()` keeps one Octokit per installation (`@octokit/auth-app` signs the
  App JWT and caches the installation token until shortly before expiry). Octokit's `request.fetch`
  is `githubFetch`, so every GitHub call is SSRF-guarded and pinned to api.github.com.
- **The check** (`jobs.ts#prCheck`, tested against a mocked Octokit in `test/pr-check-job.test.ts`):
  mode `off` → nothing at all. Otherwise `buildReport()`: both trees (recursive; truncated → not
  checked), `selectTreeFiles()` (the CLI's rules, `.gitignore` read top-down), every blob reserved
  against `createFetchBudget()` (2,000 files / 20 MB, PR patches included) **before** downloading,
  each distinct blob once; `scanFiles()` on both sides; `diffEnvVars()` (variable level; rename =
  removed + added in the same file; declared = in the `.env.example` of every scope that reads it);
  committed env files the PR adds or changes; `findSecrets()` on added lines (rule + file:line only).
  A cap → neutral "too large to check". Conclusion: success when nothing is undeclared and no env
  files or secrets; else neutral (comment) or failure (strict).
- **Idempotent output.** One `pr_checks` row per project + PR + head (upsert keeps comment and check
  run ids). One comment per PR: stored id → else the latest row's → else the App's comment with the
  `<!-- deployhealth-env-check -->` marker; created only when there's something to say, recreated if
  deleted (404). One `deployhealth / env` check run per head, updated on re-runs.
- **Agents:** PR author login (without `[bot]`) in the known list, else a `Co-Authored-By` trailer
  naming Claude, Codex, Copilot, Cursor or Devin. Dependabot and Renovate are never agents.
- **Never values.** Comments, check runs, rows and logs carry names, paths, line numbers and rule
  ids only. Test fixtures that look like secrets are assembled at run time (see the tests).

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
  deploy's latest scan, and list only the MISSING vars that are **new**. Scopes with no env file
  have no MISSING rows, so for those (only when the scan has `env_scopes`, i.e. CLI 0.2.0+) the
  new list is the non-optional variables they reference that the previous scan didn't reference at
  all (its variables plus its findings' names; no previous scan: all of them). The message is built
  by `alertOpenedMessage()`: "…started failing 4m after deploy b52952e, which introduced 2 missing
  env vars: …", "…which introduced 2 new env vars no env file declares: …" (both kinds joined by
  ", plus"), "…which had no new config findings", or "…no deploy in the 30 minutes before the
  first failure".
- **Webhook:** if `projects.alert_webhook_url` is set, POST `{text}` on open and on resolve. Log
  and continue on failure; at most one retry.
- **Down duration:** "Down for 21m" (or "Failing for 1m" before an alert opens) next to endpoint
  and project badges is measured from the first failed check of the current run:
  `failingSinceSql()` in `monitoring.ts` (also used for the alert's first failure), exposed as
  `EndpointMonitoring.failingSince` and `ProjectListItem.failingSince`, and labelled by
  `failingFor()` in core.

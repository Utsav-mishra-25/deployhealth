# Development

Running deployhealth locally, the tests and checks, the repository's top-level files, and the
conventions that hold everywhere (licensing, env vars). Read before changing tooling, scripts,
CI, licensing or how an app reads its environment.

## Phases built

Phase 1 (config health), Phase 2 (clients, uptime, alerts), Phase 3 (public demo, handoff
export, monthly client reports), Phase 4 (licensing, the npm CLI, hard caps, /security, and the
GitHub App's env check on every pull request), Phase 4.5 (launch polish: landing page, a demo
that's fresh at any hour, phone layouts, /privacy and /terms, metadata, security headers) and
Phase 4.6 (scanner accuracy on real repos, CLI 0.3.0), Phase 4.7 (launch-week hardening: the
worker waits for migrations, a deep health check that sees the worker, capped alert lists) and
Phase 4.8 (security fixes: the PR check runs isolated with a time limit, linear-time scanning and
gitignore matching, an env parser that never reads a value as a name, more SSRF ranges, fair
claims, CLI 0.3.1) and Phase 4.9 (unsupported stacks say so: the PR check and the CLI say what
they read and "can't check" a repo in a language they don't read, setup split into pull request
checks and deploy history, CLI 0.3.2), Phase 5 (more stacks: PHP and Laravel, Java and Kotlin with Spring; CLI 0.5.0) and
Phase 6 (readable data and stats, the docs pages, the **deployhealth env check** Action on the
Marketplace, the footer docs link, and the security review's items: a hardened publish workflow,
per-hostname spacing worded as it works, a bounded DNS resolver and a limit on endpoint saves, an
App status that can't reveal other accounts' repositories, absolute URLs from `PUBLIC_ORIGIN`,
/security stating strict mode's limit (too large or couldn't be checked is neutral),
the token kept out of the Action snippet's command line, and e2e on a production build) and
Phase 7 part 1 (a freelancer-first landing page with a product screenshot, a header nav on every
public page, /pricing, a friendly 404 and a guide on /demo), Phase 8.1 (first-run onboarding:
the setup checklist, the install round trip back to the step it started from, App coverage per
repository, a project page that says what will appear, no token at creation) and Phase 9 part 1
(production readiness: redacted logs, Sentry error reports, operator alerts, self-serve export and
deletion on /account with a deletion record, a status page link, incident and maintenance
runbooks) and part 2 (daily backups to Cloudflare R2 from a separate backup service on Postgres
18's client, a restore command that re-applies account deletions, a stale-backup alert) are built.

## Repository files

```
docker-compose.yml    Postgres 18, like production (creates deployhealth and deployhealth_test; volume pgdata18)
.dockerignore         for apps/worker/backup.Dockerfile (the backup service): no env files, dependencies or build output
LICENSE               FSL-1.1-MIT (everything except packages/core, which has its own MIT LICENSE)
.github/workflows/ci.yml   typecheck, lint, unit tests, build; e2e on a production build (parallel job)
.github/workflows/deployhealth.yml   dogfood: the published CLI reports this repo on every push to main
.github/workflows/publish-cli.yml    manual, not used yet: build job, then a publish job behind the npm-publish environment
docs/deploy-railway.md     Railway dashboard steps and every variable (root directory stays empty)
docs/incident.md           what to check, in order, when the site or the worker is down; the status page
docs/maintenance.md        planned downtime, migrations, restoring a backup, rotating the GitHub App key, webhook secret and others
scripts/eval-repos.mjs     `pnpm eval:repos`: scanner accuracy on pinned public repos (manual, not in CI)
scripts/laravel-framework-names.mjs  `pnpm laravel:names`: regenerates core's LARAVEL_FRAMEWORK_NAMES from
                           pinned laravel/framework tags (manual, not in CI, not shipped)
scripts/load-demo.mjs      `pnpm load:demo`: p50/p95/errors/rps of the public pages on `next start` (manual)
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

## Tests and checks

```sh
pnpm test            # all unit tests: core, db (real Postgres), web, worker (all Vitest)
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e             # Playwright smoke test (see below)
pnpm scan:self       # run deployhealth's own scanner on this repo; must report nothing
pnpm eval:repos      # manual: counts per repo on pinned public repos (--cli "npx --yes deployhealth-scan@x.y.z" to compare)
pnpm laravel:names   # manual: report and check the Laravel framework names (--write to regenerate)
pnpm load:demo       # manual: builds web, `next start` on :3200, 20 connections × 30 s per public page (--url, --no-build)
```

- One file: `pnpm --filter @deployhealth/core exec vitest run test/scan.test.ts`.
- **db tests** use `TEST_DATABASE_URL` (default `.../deployhealth_test`). Global setup drops and
  re-migrates that database's schema on every run, so never point it at real data. The backup
  test also creates and drops `deployhealth_restore_test`, and needs `pg_dump` and `pg_restore` of
  at least the server's major version on `PATH` (18 for docker-compose's and CI's Postgres:
  `postgresql-client-18`, or `brew install postgresql@18`). Moving from the old Postgres 16 volume:
  `docker compose down`, then `up -d` creates the new `pgdata18` volume (empty; run
  `pnpm db:migrate` and `pnpm db:seed` again).
- **e2e** runs on a production build: `pnpm e2e` builds core and web (`next build`), then
  Playwright starts `next start` on :3100 (never reusing a server already there) with the demo on,
  `PUBLIC_ORIGIN=http://localhost:3100` and placeholder `AUTH_GITHUB_*` (required in production,
  never contacted). Global setup re-seeds the database in `apps/web/.env.local` (or the
  environment's `DATABASE_URL`) and signs the dev user in the only way a production build allows:
  the dev login is never registered there (the server gets `AUTH_DEMO_LOGIN=1` and a test checks
  /login still has no "Continue as dev user"), so it mints the Auth.js session cookie the `dev`
  provider would have produced (`authjs.session-token`, no `__Secure-` prefix over http, salted
  with its name, same claims as auth.ts's `jwt` callback) with `AUTH_SECRET`, into
  `e2e/.auth/` (gitignored). `e2e/session.ts`'s `signInAsDev()` adds it and asserts /login sends
  the user to /clients with "dev" in the header, so a rejected cookie fails at once. Assertions
  wait at most 15 s (a production build has no first-visit compile). A full run takes about
  110 s here, build included (on `next dev` it took about 250 s). The one dev-only step,
  clicking the dev login on `/login?next=`, is replaced by adding the session and reloading. It
  runs: the landing page (signed out: the hero first, the alert below it, its metadata, one click
  to the demo); the header on every public page with JavaScript off; /pricing; the demo guide's
  links; the 404's links; the public
  demo without a session (overview → project with its sample PR checks → handoff page and `.md`
  download → monthly report); a signed-in project with no env file: its "No .env.example here"
  notice → the handoff's starting `.env.example` (page and `.md`); `onboarding.spec.ts`, the first
  run on a fresh dev account (checklist → project → settings → the signed installation webhook and
  the Setup URL's `state` back to settings → the "App doesn't cover this repo" notice and its fix
  → an "All repositories" installation → the picker → a site → the optional Action's token; axe
  and 375 px on each screen). It empties the dev account before and after with `resetDevUser`
  (packages/db `dev-reset.ts`: only the dev user's projects, clients and installations; the demo
  and other users are never touched, `test/dev-reset.test.ts`), and signs deliveries with the
  fixed test secret `E2E_WEBHOOK_SECRET` (`e2e/webhook-secret.ts`, passed to the server as
  `GITHUB_APP_WEBHOOK_SECRET`); the signed-in flow as the dev user (`/` → /clients, client → project
  → scan with variables → named endpoint → SSRF rejection → untrusted deploy notes in the handoff
  → share a report → open the link in a fresh context → tampered link 404s); /privacy and /terms;
  the security headers; that a spoofed Host or X-Forwarded-Host never reaches security.txt, the
  sitemap, a docs page's canonical URL or a signed-in settings page's snippet; and `mobile.spec.ts`, which checks at 375×812 that no public or signed-in
  page (nor a shared report) scrolls sideways; and `a11y.spec.ts`, which runs axe on every public
  page (the four docs pages included), the signed-in /clients, a client page, a project page with a
  deploy, its settings page and a shared report (no serious or critical violations).
  First time:
  `pnpm --filter @deployhealth/web exec playwright install chromium` (or set
  `PLAYWRIGHT_CHROMIUM_PATH` to an existing Chromium).
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit tests and build in one job, and
  e2e in a second, parallel job: its own Postgres, `db:migrate`, a throwaway `AUTH_SECRET` per
  run, Chromium downloaded with `playwright install --with-deps chromium`, then `pnpm e2e`;
  Playwright traces are uploaded only when a test fails.

## Licensing

- **Licensing:** `packages/core` is MIT (its own `LICENSE`, `"license": "MIT"`); everything else is
  FSL-1.1-MIT (root `LICENSE`, `"license": "FSL-1.1-MIT"` in the root, apps and `packages/db`).
  Moving code into `packages/core` relicenses it as MIT, so only move what the CLI or scanner needs.
  A new package sets its `license` field.

## Env vars

- **Env vars:** each app reads `process.env` only in its `env.ts`, and by name
  (`DATABASE_URL: process.env.DATABASE_URL`), never by spreading `process.env`. That keeps
  `pnpm scan:self` meaningful. Every variable must appear in that app's `.env.example`.
  Runtime-provided ones (`NODE_ENV`) are skipped by the scanner's `DEFAULT_IGNORE`, and tests
  and fixtures are skipped by default, so the self-scan needs no `--ignore` or `--exclude`.
  The CLI (core) reads one variable, `DEPLOYHEALTH_TOKEN`, in `cli.ts`'s `nodeIo()`, declared in
  `packages/core/.env.example`. `RAILWAY_GIT_COMMIT_SHA` (Sentry's release) is set by Railway and
  skipped by `DEFAULT_IGNORE`, but still listed in web's and worker's `.env.example`. Optional
  variables whose value can be wrong without breaking the app (`PUBLIC_ORIGIN`, `SENTRY_DSN`,
  `OPERATOR_WEBHOOK_URL`, `STATUS_PAGE_URL`) are read raw and checked where they're used: a bad
  value turns the feature off with one log line, never fails the environment.

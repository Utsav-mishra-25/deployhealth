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
claims, CLI 0.3.1) are built.

## Repository files

```
docker-compose.yml    Postgres 16 (creates deployhealth and deployhealth_test)
LICENSE               FSL-1.1-MIT (everything except packages/core, which has its own MIT LICENSE)
.github/workflows/ci.yml   typecheck, lint, unit tests, build
.github/workflows/deployhealth.yml   dogfood: the published CLI reports this repo on every push to main
.github/workflows/publish-cli.yml    manual: publish deployhealth-scan to npm with provenance
docs/deploy-railway.md     Railway dashboard steps and every variable (root directory stays empty)
scripts/eval-repos.mjs     `pnpm eval:repos`: scanner accuracy on pinned public repos (manual, not in CI)
scripts/load-demo.mjs      `pnpm load:demo`: p50/p95/errors/rps of the public pages on `next start` (manual)
docs/prompts/              the phase prompts as given (4.5 onwards) and the review loop
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
pnpm load:demo       # manual: builds web, `next start` on :3200, 20 connections × 30 s per public page (--url, --no-build)
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

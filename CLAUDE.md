# CLAUDE.md

deployhealth is a dashboard that answers two questions about each deployment: is it configured
correctly (env var drift between code and env files), and is it actually up (uptime/latency). Both
land on one timeline per project.

Phase 1 (config health) is built. Phase 2 (uptime checks, alerts, correlation) is next; its tables
already exist.

## Monorepo layout

```
apps/
  web/                Next.js 15 App Router + Tailwind. UI, Auth.js, POST /api/ingest/scan
    src/env.ts        the ONLY place web reads process.env (by name, validated lazily)
    src/auth.ts       Auth.js v5: GitHub OAuth + dev-only demo login, JWT sessions, no adapter
    src/lib/          ingest handler (unit-tested), db accessor, auth providers, formatting
    src/app/          routes: /login, /projects, /projects/new, /projects/[id], /projects/[id]/settings
    e2e/              Playwright smoke test (login → create project → view project)
    railway.json      Railway service config (build, pre-deploy migration, healthcheck)
  worker/             plain Node process running pg-boss. Phase 1: boots and idles
    src/env.ts        the ONLY place the worker reads process.env
    railway.json
packages/
  core/               scanner + shared contract, no framework deps
    src/scan.ts       scanProject(): walks the repo, env scopes, findings rows
    src/scanner.ts    per-language regexes (JS/TS, Python, Go, Ruby)
    src/findings.ts   analyzeScope() / summarize(): MISSING, UNUSED, MISMATCH
    src/ingest.ts     zod payload schema, token generate/hash/hint, GitHub Action snippet
    src/cli.ts        deployhealth-scan (bundled by tsup into one 11 KB file, served by web)
    src/browser.ts    `@deployhealth/core/browser`: types + constants safe for client components
  db/                 Drizzle schema, migrations (drizzle/), queries, seed
    src/schema.ts     users, projects, deploys, scans, findings, endpoints, checks, alerts
    src/queries.ts    every read/write the apps use; owner checks live here
    src/seed.ts       demo user + acme-storefront + 10 deploys
docker-compose.yml    Postgres 16 (creates deployhealth and deployhealth_test)
.github/workflows/ci.yml   typecheck, lint, unit tests, build
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
account) and everything it owns, then recreates it with project `acme-storefront` and 10 deploys
spread over ~9 days. It's safe to re-run and never touches other users. It prints a fresh ingest
token, so you can post a real scan:

```sh
pnpm --filter @deployhealth/core build
node packages/core/bin/deployhealth-scan.mjs --url http://localhost:3000 --token dh_... \
  --dir packages/core/test/fixtures/project --sha 0123456789abcdef0123456789abcdef01234567 --branch main
```

## Tests and checks

```sh
pnpm test            # all unit tests: core (Vitest), db (Vitest + real Postgres), web (Vitest)
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
  login on, and runs the login → create project → view project flow. First time:
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
- **Authorization:** every project read or write goes through an owner-scoped query
  (`getProjectForOwner`, `rotateProjectToken(..., ownerId)`, `listProjectsForOwner`). Route params
  are checked with `isUuid()` before they reach a uuid column.
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
- **Scanner fixture:** `packages/core/test/fixtures/project` is deliberately broken and must stay
  in sync with the expectations in `test/scan.test.ts`. Its `.env` files are committed through
  negations in the root `.gitignore`. Decoys (node_modules, dist, .git, …) are written into a temp
  copy at test time rather than committed.

## Phase 2 rules (agreed, not yet implemented)

- **Correlation:** compare each deploy's scan with the previous deploy's scan for the same
  project. An alert references only the MISSING variables that are **new** in this deploy. If
  there are none, the message says the deploy had no new findings.
- **Alert threshold:** 2 consecutive failed checks, but only after the endpoint has recorded at
  least one ok check. Link the alert (`related_deploy_id`) to the most recent deploy in the 30
  minutes before the first failure.

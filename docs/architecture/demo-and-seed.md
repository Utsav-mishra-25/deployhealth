# Demo and seed

The public read-only demo, the guard that keeps it read-only, and the seed that builds it. Read
before changing `packages/db/src/seed.ts`, anything under `apps/web/src/app/demo`, a server action,
or the reseed schedule.

## Layout

```
    src/demo.ts       demo user (-1, read-only) and dev user (-2), fixed demo project ids
    src/seed.ts       the demo: 2 clients, 3 projects, named endpoints, 7 days of checks, scripted alert
    src/seed-cli.ts   `pnpm db:seed` (kept apart so importing the seed runs nothing)
```

## Read-only demo

- **Read-only demo:** every server action calls `requireWritableUser()` (`lib/guard.ts`) first,
  before touching its arguments or the database. It throws `ReadOnlyDemoError` for the demo user,
  whatever route the request came from. `test/guard.test.ts` finds every exported function in every
  `'use server'` module and calls it as the demo user, with every db function trapped; it also pins
  the list of files with inline server actions (sign-in/out only). New actions are covered
  automatically, but they must start with `requireWritableUser()`, and a `'use server'` module may
  export only async functions.

## Demo mode

- **Demo mode:** `DEMO_PUBLIC=1` serves `/demo/...` from the same views as the signed-in pages
  (`src/views/`, `readOnly` + `DEMO_PATHS`), with no session: pages call `demoOwner()` (404 when the
  flag is off or the demo isn't seeded), route handlers `findDemoOwner()`. `test/demo.test.ts`
  checks every file under `app/demo` does, and none touches `@/auth`. `/api/demo/broken` is the
  demo's failing endpoint (503, no body) and 404s with the flag off.

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

# Deploy to Railway

deployhealth runs on Railway as three services in one project: **Postgres**, **web** (Next.js)
and **worker** (pg-boss). Every build and deploy setting is entered by hand in each service's
dashboard (steps 2.4 and 3.4), along with the source, the variables and a domain.

**About `railway.json`.** Railway has deprecated config-as-code, and new services can't opt in to
it. `apps/web/railway.json` and `apps/worker/railway.json` are kept in the repo as documentation
only: Railway doesn't read them; they record the values the tables below tell you to enter.
If you change one, change the dashboard (and this guide) to match.

Time needed: about 15 minutes, plus a GitHub OAuth app (step 5).

## Before you start

- The code is on GitHub (`<you>/deployhealth`, branch `main`).
- Your Railway account can see that repository (Railway → Account → Integrations → GitHub).
- You can run `openssl` locally, to generate `AUTH_SECRET`.

## Why the root directory stays empty

This is a pnpm workspace: `apps/web` and `apps/worker` import `packages/core` and `packages/db`,
and the lockfile is at the repo root. If a service's **Root Directory** is set to `apps/web` or
`apps/worker`, Railway builds from that folder only, `packages/` and `pnpm-lock.yaml` are missing,
and `pnpm install` fails on the `workspace:*` dependencies. So both services build from the repo
root, and their build and start commands pick the app with `pnpm --filter` (the `...` suffix in
the build command builds the workspace packages it depends on first).

## 1. Create the project and the database

1. Railway → **New Project** → **Empty Project**.
2. **+ Create** → **Database** → **PostgreSQL**. Keep the service name **`Postgres`** (the
   variable references below use it).

## 2. Add the `web` service

1. **+ Create** → **GitHub Repo** → pick `deployhealth`.
2. Rename the service to **`web`** (service → **Settings** → name at the top).
3. **Settings → Source**
   - **Root Directory:** leave empty.
   - **Branch:** `main`.
4. **Settings → Build** and **Settings → Deploy**: set each field by hand. The values are the
   ones in `apps/web/railway.json`.

   | Section | Field | Value |
   | --- | --- | --- |
   | Build | Builder | Railpack (`RAILPACK` in the file) |
   | Build | Build command | `pnpm --filter @deployhealth/web... build` |
   | Build | Watch paths | the 7 patterns below, one per line |
   | Deploy | Pre-deploy command | `node packages/db/dist/migrate.js` (applies database migrations) |
   | Deploy | Start command | `pnpm --filter @deployhealth/web start` |
   | Deploy | Healthcheck path | `/api/health` |
   | Deploy | Restart policy | On Failure (`ON_FAILURE`), default max retries |

   Watch paths (a push that touches none of them doesn't redeploy web):

   ```
   /apps/web/**
   /packages/**
   /package.json
   /pnpm-lock.yaml
   /pnpm-workspace.yaml
   /tsconfig.base.json
   /.nvmrc
   ```

5. **Variables** (**Raw Editor** is fastest):

   | Name | Value | Where it comes from |
   | --- | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the Postgres service (private network) |
   | `AUTH_SECRET` | output of `openssl rand -base64 32` | Generate it locally. Use a new value, not your dev one |
   | `NODE_ENV` | `production` | Literal |
   | `AUTH_GITHUB_ID` | Client ID | The GitHub OAuth app from step 5 (add it then) |
   | `AUTH_GITHUB_SECRET` | Client secret | The GitHub OAuth app from step 5 (add it then) |
   | `REPORT_SHARE_SECRET` | output of `openssl rand -base64 32` | Optional. Signs report share links; see below |
   | `DEMO_PUBLIC` | `1` | Optional. Serves the read-only public demo at `/demo` (and `/api/demo/broken`). `0` or unset turns both off (404) |

   Never set `AUTH_DEMO_LOGIN` here. The demo login is disabled in production anyway.

   **Report share links and `AUTH_SECRET`.** Share links are signed with `REPORT_SHARE_SECRET`. If
   it's unset, a key is derived from `AUTH_SECRET` (HKDF), so rotating `AUTH_SECRET` signs everyone
   out *and* invalidates every share link you've sent. Set `REPORT_SHARE_SECRET` to rotate them
   separately; rotating it invalidates all share links at once (that's the only way to revoke one).

6. **Settings → Networking → Generate Domain.** If Railway asks for a port, use the one in the
   deploy log's `Local: http://localhost:<port>` line (Railway sets `PORT`, and `next start`
   listens on it). Note the URL, e.g. `https://web-production-1234.up.railway.app`.

## 3. Add the `worker` service

1. **+ Create** → **GitHub Repo** → pick `deployhealth` again.
2. Rename the service to **`worker`**.
3. **Settings → Source → Root Directory:** leave empty. **Branch:** `main`.
4. **Settings → Build** and **Settings → Deploy**: set each field by hand. The values are the
   ones in `apps/worker/railway.json`.

   | Section | Field | Value |
   | --- | --- | --- |
   | Build | Builder | Railpack (`RAILPACK` in the file) |
   | Build | Build command | `pnpm --filter @deployhealth/worker... build` |
   | Build | Watch paths | the 7 patterns below, one per line |
   | Deploy | Pre-deploy command | leave empty (web runs the migrations) |
   | Deploy | Start command | `pnpm --filter @deployhealth/worker start` |
   | Deploy | Healthcheck path | leave empty (the worker has no HTTP server) |
   | Deploy | Restart policy | Always (`ALWAYS`) |

   Watch paths:

   ```
   /apps/worker/**
   /packages/**
   /package.json
   /pnpm-lock.yaml
   /pnpm-workspace.yaml
   /tsconfig.base.json
   /.nvmrc
   ```
5. **Variables:**

   | Name | Value | Where it comes from |
   | --- | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the Postgres service |
   | `NODE_ENV` | `production` | Literal |
   | `DEMO_PUBLIC` | `1` | Same value as on web. Runs the `reseed-demo` job nightly and once on start, so the demo data exists without a manual seed step |
   | `DEMO_BASE_URL` | `https://<your-domain>` | web's public URL from step 2.6. Required when `DEMO_PUBLIC=1`: the demo's failing "Acme API" endpoint is `<DEMO_BASE_URL>/api/demo/broken` |

   `DEMO_BASE_URL` is only read by the worker, so web doesn't need it.

6. No domain and no health check: the worker has no HTTP server.

## 4. Deploy

Click **Deploy** on the staged-changes banner (or **Deploy** on each service).

- **Migrations** run automatically in web's pre-deploy step, before the new version takes
  traffic. There is nothing to run by hand. If that step fails, the deploy stops and the previous
  version keeps serving.
- The **worker** creates its own `pgboss` schema on start. If it starts before web's first
  migration, its first check cycle logs a missing-table error and the next cycle (a minute later)
  succeeds.
- **What to expect before step 5:** `https://<your-domain>/api/health` returns `{"ok":true}`, so
  the deploy passes its health check, but every page returns a 500 whose log says
  `AUTH_GITHUB_ID and AUTH_GITHUB_SECRET are required in production`. That is the deliberate
  fail-fast config check; step 5 clears it.

## 5. Sign-in with GitHub

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
   - **Application name:** deployhealth
   - **Homepage URL:** `https://<your-domain>`
   - **Authorization callback URL:** `https://<your-domain>/api/auth/callback/github`
2. **Register application**, then **Generate a new client secret**.
3. On the **web** service, set `AUTH_GITHUB_ID` (Client ID) and `AUTH_GITHUB_SECRET` (the secret).
   Railway redeploys web.

## 6. Check it works

- `https://<your-domain>/login` shows **Sign in with GitHub**, and signing in lands on `/clients`.
- Worker logs show `[worker] ready: check-endpoints every minute, prune-checks nightly`, then one
  `[check] {...}` line per minute once you have endpoints.
- `https://<your-domain>/deployhealth-scan.mjs` downloads the CLI (about 11 KB). The GitHub Action
  snippet on each project's settings page uses it.
- With the demo on: `https://<your-domain>/demo` shows Acme Corp and Northwind Bakery without
  signing in, the worker log shows `[reseed-demo] demo data restored in …ms` after each start, and
  within a couple of minutes "Acme API" is failing for real (its checks show `Expected 200, got 503`).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Build fails resolving `@deployhealth/core` or `workspace:*` | A Root Directory is set. Clear it (step 2.3 / 3.3). |
| The build or start runs the wrong command (e.g. the root `pnpm build`) | A field from step 2.4 / 3.4 is empty or mistyped, so Railpack used its default. Compare it with the table. |
| Every push redeploys both services | The watch paths are empty. Add the patterns from step 2.4 / 3.4. |
| Every page 500s; the log mentions `AUTH_GITHUB_*` | Step 5 isn't done, or a value is empty. |
| Every page 500s; the log mentions `AUTH_SECRET` | It is shorter than 32 characters. Regenerate it with `openssl rand -base64 32`. |
| GitHub says the redirect URI is not associated | The callback URL doesn't exactly match `https://<your-domain>/api/auth/callback/github`. |
| Worker logs `relation "endpoints" does not exist` repeatedly | web hasn't deployed successfully yet, so migrations haven't run. Fix web first. |
| Worker exits with `DEMO_PUBLIC=1 needs DEMO_BASE_URL` | Set `DEMO_BASE_URL` on the worker to web's public URL, or set `DEMO_PUBLIC=0`. |
| `/demo` is a 404 | `DEMO_PUBLIC` isn't `1` on web, or the worker hasn't reseeded yet (check its log). |

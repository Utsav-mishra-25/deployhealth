# Deploy to Railway

deployhealth runs on Railway as three services in one project: **Postgres**, **web** (Next.js)
and **worker** (pg-boss). The build and deploy settings live in `apps/web/railway.json` and
`apps/worker/railway.json`, so the dashboard only needs the source, the config file path, the
variables and a domain.

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
root, and each one points at its own config file instead.

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
4. **Settings → Config-as-code → Railway Config File:** `/apps/web/railway.json`.
   The build, deploy and health-check settings then show as managed by that file:

   | Setting | Value (from the file) |
   | --- | --- |
   | Builder | Railpack |
   | Build command | `pnpm --filter @deployhealth/web... build` |
   | Pre-deploy command | `node packages/db/dist/migrate.js` (applies database migrations) |
   | Start command | `pnpm --filter @deployhealth/web start` |
   | Health check path | `/api/health` |
   | Restart policy | On failure |
   | Watch paths | `/apps/web/**`, `/packages/**` and the root workspace files |

5. **Variables** (**Raw Editor** is fastest):

   | Name | Value | Where it comes from |
   | --- | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the Postgres service (private network) |
   | `AUTH_SECRET` | output of `openssl rand -base64 32` | Generate it locally. Use a new value, not your dev one |
   | `NODE_ENV` | `production` | Literal |
   | `AUTH_GITHUB_ID` | Client ID | The GitHub OAuth app from step 5 (add it then) |
   | `AUTH_GITHUB_SECRET` | Client secret | The GitHub OAuth app from step 5 (add it then) |

   Never set `AUTH_DEMO_LOGIN` here. The demo login is disabled in production anyway.

6. **Settings → Networking → Generate Domain.** If Railway asks for a port, use the one in the
   deploy log's `Local: http://localhost:<port>` line (Railway sets `PORT`, and `next start`
   listens on it). Note the URL, e.g. `https://web-production-1234.up.railway.app`.

## 3. Add the `worker` service

1. **+ Create** → **GitHub Repo** → pick `deployhealth` again.
2. Rename the service to **`worker`**.
3. **Settings → Source → Root Directory:** leave empty. **Branch:** `main`.
4. **Settings → Config-as-code → Railway Config File:** `/apps/worker/railway.json`
   (build `pnpm --filter @deployhealth/worker... build`, start
   `pnpm --filter @deployhealth/worker start`, restart always).
5. **Variables:**

   | Name | Value | Where it comes from |
   | --- | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the Postgres service |
   | `NODE_ENV` | `production` | Literal |

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

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Build fails resolving `@deployhealth/core` or `workspace:*` | A Root Directory is set. Clear it (step 2.3 / 3.3). |
| Build settings aren't the ones above | The config file path is wrong or missing. It must start with `/apps/`. |
| Every page 500s; the log mentions `AUTH_GITHUB_*` | Step 5 isn't done, or a value is empty. |
| Every page 500s; the log mentions `AUTH_SECRET` | It is shorter than 32 characters. Regenerate it with `openssl rand -base64 32`. |
| GitHub says the redirect URI is not associated | The callback URL doesn't exactly match `https://<your-domain>/api/auth/callback/github`. |
| Worker logs `relation "endpoints" does not exist` repeatedly | web hasn't deployed successfully yet, so migrations haven't run. Fix web first. |

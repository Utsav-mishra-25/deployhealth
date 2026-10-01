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
   | `PORT` | `3000` | Optional. See step 2.6 |
   | `SECURITY_CONTACT_EMAIL` | e.g. `security@yourdomain.com` | Optional but recommended. Shown on `/security` and in `/.well-known/security.txt` as where to report vulnerabilities. Unset, both point at a private security advisory on the GitHub repo |
   | `GITHUB_APP_WEBHOOK_SECRET` | the webhook secret you set on the App | Optional: the GitHub App from step 8. Verifies every webhook delivery; unset, `/api/github/webhook` answers 404 |
   | `GITHUB_APP_SLUG` | e.g. `deployhealth` | Optional: the App's URL name (`github.com/apps/<slug>`), for the install link on project settings |

   Never set `AUTH_DEMO_LOGIN` here. The demo login is disabled in production anyway.

   **Report share links and `AUTH_SECRET`.** Share links are signed with `REPORT_SHARE_SECRET`. If
   it's unset, a key is derived from `AUTH_SECRET` (HKDF), so rotating `AUTH_SECRET` signs everyone
   out *and* invalidates every share link you've sent. Set `REPORT_SHARE_SECRET` to rotate them
   separately; rotating it invalidates all share links at once (that's the only way to revoke one).

6. **Settings → Networking → Generate Domain.** Railway injects its own `PORT` variable, and
   `next start` listens on whatever `PORT` says, so the domain must point at that port. Either:
   - set `PORT=3000` in web's variables and give the domain port **3000**, or
   - leave `PORT` unset and point the domain at the injected port, shown in the deploy log's
     `Local: http://localhost:<port>` line.

   Note the URL, e.g. `https://web-production-1234.up.railway.app`.

   **Custom domain** (the hosted instance uses `https://deployhealth.dev`): **Settings →
   Networking → Custom Domain**, add the DNS record Railway shows, and wait for the certificate.
   Then use the custom domain everywhere a URL is configured: the GitHub OAuth callback (step 5),
   `DEMO_BASE_URL` (step 3.5) and the GitHub App's webhook URL. The Railway domain keeps working
   as an alias, but GitHub sign-in only works on the domain registered as the OAuth callback.

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
   | `DEMO_PUBLIC` | `1` | Same value as on web. Runs the `reseed-demo` job every 30 minutes and once on start, so the demo data exists without a manual seed step and stays recent |
   | `DEMO_BASE_URL` | `https://<your-domain>` | web's public URL from step 2.6. Required when `DEMO_PUBLIC=1`: the demo's failing "Acme API" endpoint is `<DEMO_BASE_URL>/api/demo/broken` |
   | `GITHUB_APP_ID` | e.g. `1234567` | Optional: the GitHub App from step 8 (its numeric App ID). Set it with the key, or neither |
   | `GITHUB_APP_PRIVATE_KEY` | the App's `.pem`, base64 on one line | Optional: see step 8 for the one-line encoding. The worker refuses to start if it can't parse it |

   `DEMO_BASE_URL` is only read by the worker, so web doesn't need it.

6. No domain and no health check: the worker has no HTTP server.

## 4. Deploy

Click **Deploy** on the staged-changes banner (or **Deploy** on each service).

- **Migrations** run automatically in web's pre-deploy step, before the new version takes
  traffic. There is nothing to run by hand. If that step fails, the deploy stops and the previous
  version keeps serving.
- The **worker** waits for them: before it starts pg-boss or works any queue, it checks that the
  database has every migration it was built with. Until web's pre-deploy step has applied them it
  logs `[worker] waiting for migrations: 1 of 8 not applied, next try in 5s` (or `waiting for the
  database (ECONNREFUSED)`) every 5 seconds. After 10 minutes it exits non-zero and Railway
  restarts it. Then it creates its own `pgboss` schema and starts.
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
- Worker logs show `[worker] ready: check-endpoints every minute, prune-checks nightly` (plus
  `reseed-demo every 30 minutes and now` with the demo on), then one
  `[check] {...}` line per minute once you have endpoints.
- `https://<your-domain>/api/health/worker` returns `{"ok":true}` within a minute or two of the
  worker's start (it reads the heartbeat `check-endpoints` writes every minute), and
  `{"ok":false}` with a 503 if the worker hasn't finished a run in the last 3 minutes.
- A project's settings page shows the GitHub Action, which runs `npx --yes deployhealth-scan@<version>`
  from npm. (`https://<your-domain>/deployhealth-scan.mjs` still serves the old CLI download for
  older workflows, with a `Deprecation` header.)
- With the demo on: `https://<your-domain>/demo` shows Acme Corp and Northwind Bakery without
  signing in, the worker log shows `[reseed-demo] demo data restored in …ms` after each start and every 30 minutes, and
  within a couple of minutes "Acme API" is failing for real (its checks show `Expected 200, got 503`).

## 7. Verify the rate limiter

Shared reports (`/share/*`) are rate-limited per client IP, taken from the **last**
`X-Forwarded-For` entry: the one Railway's edge proxy adds. Earlier entries come from the client,
so check a client can't pick its own IP. Send a spoofed header (`203.0.113.7` is a documentation
address; any made-up value works):

```sh
curl -s 'https://<your-domain>/api/health?ip=1' -H 'X-Forwarded-For: 203.0.113.7'
curl -s https://api.ipify.org; echo    # your real public IP, to compare
```

`?ip=1` makes web log one line (without it, `/api/health` logs nothing). In web's **Deploy Logs**:

```
[health] client ip 198.51.100.23 (x-forwarded-for: 203.0.113.7, 198.51.100.23)
```

The `client ip` must be your real IP (the second command's output, or your IPv6 address if the
request went over IPv6), **not** `203.0.113.7`. If it shows the spoofed value, the proxy passed your
header through without adding its own hop: anyone could dodge the limit by changing the header.
Don't rely on the limiter in that case, and open an issue.

## 8. GitHub App: env checks on pull requests (optional)

The App comments on every pull request in the repos it's installed on (for projects whose repo
matches), and adds a `deployhealth / env` check run. Its settings are recorded in
[`docs/github-app-manifest.json`](github-app-manifest.json).

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**:

   | Field | Value |
   | --- | --- |
   | GitHub App name | `deployhealth` (must be unique on GitHub; the slug follows from it) |
   | Homepage URL | `https://<your-domain>` |
   | Callback URL | leave empty; untick **Request user authorization (OAuth) during installation** |
   | Setup URL | `https://<your-domain>/github/installed`, and tick **Redirect on update** |
   | Webhook | **Active** ticked; URL `https://<your-domain>/api/github/webhook` |
   | Webhook secret | output of `openssl rand -hex 32` (keep it for `GITHUB_APP_WEBHOOK_SECRET`) |
   | Repository permissions | **Checks: Read and write**, **Contents: Read-only**, **Metadata: Read-only**, **Pull requests: Read and write**; everything else No access |
   | Subscribe to events | **Pull request** (installation events reach every App without subscribing) |
   | Where can this GitHub App be installed? | **Any account** |

2. **Create GitHub App.** On the App's page note the **App ID** and the slug in its public link
   (`https://github.com/apps/<slug>`).
3. **Private keys → Generate a private key.** GitHub downloads a `.pem`. Encode it on one line:
   - macOS / Linux: `base64 < deployhealth.*.private-key.pem | tr -d '\n'`
   - Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("deployhealth.private-key.pem"))`
4. Set the variables, straight into Railway (never into a file in the repo or a chat):
   - **web:** `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`
   - **worker:** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`
5. Delete the downloaded `.pem` once the worker has started cleanly (GitHub can issue a new key any
   time; revoke the old one there).
6. Check: the App's **Advanced → Recent Deliveries** shows the `ping` answered with **202**.

## 9. External monitors

Railway's healthcheck only gates a web deploy. Two free external monitors tell you within minutes
when the site or the worker goes down. Use [Better Stack](https://betterstack.com/uptime) (free:
3-minute checks) or [UptimeRobot](https://uptimerobot.com) (free: 5-minute checks):

| Monitor | URL | Alert when | Interval |
| --- | --- | --- | --- |
| deployhealth web | `https://<your-domain>/api/health` | status isn't 200 | 3 min (Better Stack) / 5 min (UptimeRobot) |
| deployhealth worker | `https://<your-domain>/api/health/worker` | status isn't 200 | 3 min / 5 min |

- `/api/health` never touches the database: it's down only when web is. `/api/health/worker` is
  200 when the worker finished a `check-endpoints` run in the last 3 minutes, else 503 (also when
  web can't read the database). Its body is only `{"ok":true}` or `{"ok":false}`.
- With a 3-minute monitor a dead worker alerts within about 6 minutes (3 for the heartbeat to go
  stale, up to 3 for the next check); with a 5-minute one, within about 8.
- Both routes are `no-store`, and the deep check is rate-limited to 30 requests a minute per IP,
  far above any monitor. A plain status check (GET or HEAD) is enough; a keyword check for
  `"ok":true` works too.
- Expect the worker monitor to go red for a few minutes during a deploy that adds a migration
  (the worker waits for it, step 4). Set the monitor's confirmation period (Better Stack) or
  "alert after" (UptimeRobot) to a few minutes if that's noisy.
- If Cloudflare's **Bot Fight Mode** is on, monitors may get a challenge page (403) instead of the
  app. Add a WAF custom rule that skips it for `URI Path starts with /api/health`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Build fails resolving `@deployhealth/core` or `workspace:*` | A Root Directory is set. Clear it (step 2.3 / 3.3). |
| The build or start runs the wrong command (e.g. the root `pnpm build`) | A field from step 2.4 / 3.4 is empty or mistyped, so Railpack used its default. Compare it with the table. |
| Every push redeploys both services | The watch paths are empty. Add the patterns from step 2.4 / 3.4. |
| The domain returns "Application failed to respond" | The domain's port isn't the one web listens on. See step 2.6: set `PORT=3000` or use the injected port. |
| Every page 500s; the log mentions `AUTH_GITHUB_*` | Step 5 isn't done, or a value is empty. |
| Every page 500s; the log mentions `AUTH_SECRET` | It is shorter than 32 characters. Regenerate it with `openssl rand -base64 32`. |
| GitHub says the redirect URI is not associated | The callback URL doesn't exactly match `https://<your-domain>/api/auth/callback/github`. |
| Worker logs `waiting for migrations` and restarts every 10 minutes | web hasn't deployed successfully yet, so migrations haven't run. Fix web first. |
| `/api/health/worker` answers 503 | The worker isn't running, is waiting for migrations, or its `check-endpoints` runs fail (its log says why). |
| Worker exits with `DEMO_PUBLIC=1 needs DEMO_BASE_URL` | Set `DEMO_BASE_URL` on the worker to web's public URL, or set `DEMO_PUBLIC=0`. |
| GitHub App deliveries answer 401 | `GITHUB_APP_WEBHOOK_SECRET` on web doesn't match the App's webhook secret. |
| GitHub App deliveries answer 404 | `GITHUB_APP_WEBHOOK_SECRET` isn't set on web. |
| `/demo` is a 404 | `DEMO_PUBLIC` isn't `1` on web, or the worker hasn't reseeded yet (check its log). |

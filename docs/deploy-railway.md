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
   | `PUBLIC_ORIGIN` | `https://<your-domain>` (the hosted instance: `https://deployhealth.dev`) | web's public origin from step 2.6, no path (one trailing slash is fine). Every absolute URL comes from it (security.txt, the sitemap, canonical URLs, the Action snippet, share links), so forged host headers can't change them. Unset or invalid, pages still work but those URLs follow the request's host, and the log shows one `PUBLIC_ORIGIN is not set` or `PUBLIC_ORIGIN is invalid (…)` error at startup. Not read by Auth.js |
   | `REPORT_SHARE_SECRET` | output of `openssl rand -base64 32` | Optional. Signs report share links; see below |
   | `DEMO_PUBLIC` | `1` | Optional. Serves the read-only public demo at `/demo` (and `/api/demo/broken`). `0` or unset turns both off (404) |
   | `PORT` | `3000` | Optional. See step 2.6 |
   | `SECURITY_CONTACT_EMAIL` | e.g. `security@yourdomain.com` | Optional but recommended. Shown on `/security` and in `/.well-known/security.txt` as where to report vulnerabilities. Unset, both point at a private security advisory on the GitHub repo |
   | `GITHUB_APP_WEBHOOK_SECRET` | the webhook secret you set on the App | Optional: the GitHub App from step 8. Verifies every webhook delivery; unset, `/api/github/webhook` answers 404 |
   | `GITHUB_APP_SLUG` | e.g. `deployhealth` | Optional: the App's URL name (`github.com/apps/<slug>`), for the install link on project settings |
   | `SENTRY_DSN` | the Sentry project's DSN | Optional: error reports from web's server (step 12). Unset, nothing is sent |

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
   Then use the custom domain everywhere a URL is configured: `PUBLIC_ORIGIN` (step 2.5), the
   GitHub OAuth callback (step 5), `DEMO_BASE_URL` (step 3.5) and the GitHub App's webhook URL. The Railway domain keeps working
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
   | `SENTRY_DSN` | the same DSN as on web | Optional: error reports from the worker (step 12) |
   | `OPERATOR_WEBHOOK_URL` | a Slack (or Discord + `/slack`) incoming webhook | Optional: operator alerts (step 13) |

   `DEMO_BASE_URL` is only read by the worker, so web doesn't need it. Railway sets
   `RAILWAY_GIT_COMMIT_SHA` on both services itself (Sentry's release); don't set it.

6. No domain and no health check: the worker has no HTTP server.

## 4. Deploy

Click **Deploy** on the staged-changes banner (or **Deploy** on each service).

- **Migrations** run automatically in web's pre-deploy step, before the new version takes
  traffic. There is nothing to run by hand. If that step fails, the deploy stops and the previous
  version keeps serving.
- The **worker** waits for them: before it starts pg-boss or works any queue, it checks that the
  database has every migration it was built with. Until web's pre-deploy step has applied them it
  logs `[worker] waiting for migrations: 1 of 10 not applied, next try in 5s` (or `waiting for the
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

Shared reports (`/share/*`) and the deep health check are rate-limited per client IP, taken from
the **last** `X-Forwarded-For` entry: the one Railway's edge proxy adds. Earlier entries come from
the client, so check a client can't pick its own IP. The deep health check allows 30 requests a
minute per IP; send 31, each with a **different** made-up `X-Forwarded-For` (documentation
addresses from `203.0.113.0/24`):

```sh
for i in $(seq 1 31); do
  curl -s -o /dev/null -w '%{http_code}\n' https://<your-domain>/api/health/worker -H "X-Forwarded-For: 203.0.113.$i"
done | sort | uniq -c
```

Expect 30 answers of `200` (or `503`, if the worker isn't up yet) and **one `429`**: every request
counted against your real IP, the hop the proxy added. If all 31 get through, the limiter keyed on
the header you sent, so anyone could dodge it by changing that header: don't rely on the limiter
in that case, and open an issue. (Wait a minute before running it again: the window is per
minute.)

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
- If web's CPU sits at 100% under traffic (its **Metrics** tab), add a second replica (**Settings →
  Deploy → Replicas**). The in-memory rate limits (`/share/*`, `/api/health/worker`) then count per
  replica.

## 10. Delete a user on request

Users can export their data and delete their account themselves, on their **Account** page
(`/account`). `/privacy` also promises that a request emailed from the address on someone's GitHub
account deletes their account and everything it owns within 30 days. For that there is no route:
you run one command in the web container, where `DATABASE_URL` already points at Postgres over the
private network, so no secret leaves Railway and none is pasted anywhere. Both delete exactly the
same rows (the same function), and both record the deletion: the GitHub numeric id and the time,
in `account_deletions`, kept 35 days so a restore from backup re-applies it.

1. **Check the request.** It must come from the email address on the GitHub account it names
   (their public profile, or the address their sign-in recorded). If it doesn't, reply asking
   them to write from that address, and do nothing else.
2. **Dry run.** With the [Railway CLI](https://docs.railway.com/guides/cli) logged in and linked to
   the project (`railway link`), open a shell in the web service and run the command without
   `--confirm`. On the hosted instance the web service is named **`deployhealth`** (use the
   name it has in your project; this guide calls it `web`). The first `railway ssh` asks you to
   register an SSH key with Railway: let it.

   ```sh
   railway ssh --service deployhealth
   # in the container, from the app directory (the one holding packages/; /app on Railpack):
   node packages/db/dist/delete-user.js --login <github-login>
   ```

   It prints the user's login and GitHub id and how many rows each table holds for them, with
   the GitHub App installations split by account type (e.g. `installations  2 (1 on a user
   account, 1 on an organization)`; counts only, never names), and changes nothing. If the login matches more than one user, it says so: use
   `--github-id <id>` instead. It refuses the demo (GitHub id -1) and dev (-2) users.
3. **Delete.** Run it again with `--confirm`. It deletes, in one transaction, the user, their
   clients, projects, deploys, scans, findings, variables, endpoints, checks, daily totals and
   alerts, and every GitHub App installation linked to them or installed from their GitHub
   account (with its repository list and pull request checks). It prints what it deleted.
4. **Reply** (the command's last line reminds you of the uninstall):

   > Your deployhealth account (GitHub @<login>) and everything it held have been deleted:
   > clients, projects, deploy and scan history, endpoints and their checks, alerts, and pull
   > request checks. Pull request checks have stopped on every account you installed the
   > deployhealth GitHub App on, organizations included. Please uninstall it on GitHub
   > (Settings → Applications → Installed GitHub Apps, and in each organization's settings);
   > we can't remove it for you, and until you do, GitHub keeps sending its events, which we
   > discard.

   When the dry run showed no installation on an organization, leave out "organizations
   included" and "and in each organization's settings"; with none at all, leave out both
   sentences about the App. If you're still signed in somewhere, sign out: that session
   > now shows an empty account. Signing in again would create a new, empty account.

What the command leaves, on purpose: the `account_deletions` record (GitHub id and time, pruned
nightly after 35 days), `check_hosts` (one row per monitored hostname, with no link
to any user, pruned by age), `webhook_deliveries` (delivery ids only, pruned after 24 hours) and
pg-boss's own job rows (a pull request job holds an installation id, a repository name and a pull
request number; pg-boss deletes finished jobs on its retention schedule). A session cookie can't be
revoked (sessions are JWTs), but the next page that needs a signed-in user signs it out and shows
"Your account has been deleted".

**Last resort, only if `railway ssh` is unavailable:** run the command from a checkout of this
repository through Postgres's public TCP proxy. Enable the proxy (Postgres → **Settings →
Networking → TCP Proxy**), run the dry run and the delete with the CLI injecting the variable,
then **disable the proxy immediately**:

```sh
railway run --service Postgres -- sh -c 'DATABASE_URL="$DATABASE_PUBLIC_URL" pnpm --filter @deployhealth/db delete-user --login <github-login>'
```

Never copy the public URL into a file, a shell history line or a chat; the command above never
prints it.

## 11. Check usage

To see whether people use deployhealth, without analytics: one read-only command in the web
container, as in step 10, so no secret leaves Railway. It prints counts only, never names, logins
or repository names, and changes nothing (one read-only transaction).

```sh
railway ssh --service deployhealth
# in the container, from the app directory (the one holding packages/; /app on Railpack):
node packages/db/dist/stats.js --exclude-login <your-github-login> --exclude-login <another-of-yours>
```

```
                                   total  last 7 days  last 30 days
users                                 12            3             5
GitHub App installations               4            1             2
  on a user account                    3
  on an organization                   1
projects                              20            4             9

weekly active projects                 7  (a scan or pull request check in the last 7 days)
scans, last 7 days                    40
pull request checks, last 7 days      12

Left out: the demo and dev users, and 2 users matching 2 --exclude-login values.
```

- **Weekly active projects** is the number to watch: projects that had a scan (the Action) or a
  pull request check (the App) in the last 7 days.
- The demo (GitHub id -1) and dev (-2) users and the demo's installation are always left out.
  `--exclude-login` (repeatable, case-insensitive) leaves out your own accounts, with their
  projects and the installations linked to them or installed from them. The last line says how
  many users the values matched, so a typo shows up as fewer than you expect.
- Installations nobody has linked yet (installed, but the installer hasn't signed in) are counted.
- Locally: `pnpm --filter @deployhealth/db stats --exclude-login <login>` (reads `DATABASE_URL`
  from `packages/db/.env`).

## 12. Error reports (Sentry, optional)

With `SENTRY_DSN` set, web and worker send errors to Sentry, server side only (no browser script,
nothing added to any page). Reports are scrubbed before they leave the server: no request bodies,
headers, cookies, query strings or signed-in user; tokens, webhook URLs, email addresses, long
random strings and `NAME=value` pairs become `[redacted]` (packages/db/src/redact.ts). Each report
carries the release (the commit SHA Railway deploys), the service (`web` or `worker`), and the
route pattern or the queue.

1. [sentry.io](https://sentry.io) → **Create project** → platform **Node.js** → name it
   `deployhealth`. Skip the SDK setup screens.
2. **Project settings** → **Client Keys (DSN)**: copy the DSN.
3. Set `SENTRY_DSN` on **web** and on **worker** to that DSN. **Deploy** both.
4. Check: each service's log shows `[sentry] error reporting on, release <7 characters>` once at
   startup. `[sentry] SENTRY_DSN is not a Sentry DSN …` means the value is wrong; the service runs
   without error reports.
5. Optional, in Sentry → **Project settings** → **Security & Privacy**: keep **Data Scrubber** and
   **Use Default Scrubbers** on, as a second layer.

## 13. Operator alerts (optional)

With `OPERATOR_WEBHOOK_URL` set, the worker posts to a Slack (or Discord) channel when:

- the `check-endpoints` heartbeat is more than 3 minutes old (uptime checks aren't running), and
  once more when it's fresh again;
- a queue's job (`check-endpoints`, `prune-checks`, `reseed-demo`, `pr-check`) fails 3 times in a
  row, and once more when it succeeds again.

At most one alert of each kind an hour and 10 an hour in all. Messages name the queue, the count
and the error's name and code, never a message, URL or value. A dead worker can't post about
itself: the external monitor on `/api/health/worker` (step 9) covers that.

1. Slack: **Apps** → **Incoming Webhooks** → **Add to Slack** → pick a channel only you read →
   copy the webhook URL. Discord: channel → **Edit Channel** → **Integrations** → **Webhooks** →
   **New Webhook** → **Copy Webhook URL**, then append `/slack`.
2. Set `OPERATOR_WEBHOOK_URL` on the **worker**. **Deploy**.
3. Check: no `[operator] OPERATOR_WEBHOOK_URL is not usable` line in the worker's log. There's no
   test message; the first alert is a real one.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Build fails resolving `@deployhealth/core` or `workspace:*` | A Root Directory is set. Clear it (step 2.3 / 3.3). |
| The build or start runs the wrong command (e.g. the root `pnpm build`) | A field from step 2.4 / 3.4 is empty or mistyped, so Railpack used its default. Compare it with the table. |
| Every push redeploys both services | The watch paths are empty. Add the patterns from step 2.4 / 3.4. |
| The domain returns "Application failed to respond" | The domain's port isn't the one web listens on. See step 2.6: set `PORT=3000` or use the injected port. |
| Every page 500s; the log mentions `AUTH_GITHUB_*` | Step 5 isn't done, or a value is empty. |
| Every page 500s; the log mentions `AUTH_SECRET` | It is shorter than 32 characters. Regenerate it with `openssl rand -base64 32`. |
| The log shows `PUBLIC_ORIGIN is not set` | Pages work, but absolute URLs follow the request's host headers. Set `PUBLIC_ORIGIN` on web (step 2.5). |
| The log shows `PUBLIC_ORIGIN is invalid (…)` | The same fallback; the parentheses say what's wrong (a path, a query, no `https://`). Use just `https://<your-domain>`. |
| GitHub says the redirect URI is not associated | The callback URL doesn't exactly match `https://<your-domain>/api/auth/callback/github`. |
| Worker logs `waiting for migrations` and restarts every 10 minutes | web hasn't deployed successfully yet, so migrations haven't run. Fix web first. |
| `/api/health/worker` answers 503 | The worker isn't running, is waiting for migrations, or its `check-endpoints` runs fail (its log says why). |
| Worker exits with `DEMO_PUBLIC=1 needs DEMO_BASE_URL` | Set `DEMO_BASE_URL` on the worker to web's public URL, or set `DEMO_PUBLIC=0`. |
| GitHub App deliveries answer 401 | `GITHUB_APP_WEBHOOK_SECRET` on web doesn't match the App's webhook secret. |
| GitHub App deliveries answer 404 | `GITHUB_APP_WEBHOOK_SECRET` isn't set on web. |
| `/demo` is a 404 | `DEMO_PUBLIC` isn't `1` on web, or the worker hasn't reseeded yet (check its log). |
| A log shows `[sentry] SENTRY_DSN is not a Sentry DSN` | The value isn't a DSN (`https://<key>@<host>/<project id>`); copy it again from Sentry (step 12). The service runs without error reports. |
| The worker log shows `[operator] OPERATOR_WEBHOOK_URL is not usable` | The URL isn't a public http(s) URL; copy the webhook URL again (step 13). The worker runs without operator alerts. |

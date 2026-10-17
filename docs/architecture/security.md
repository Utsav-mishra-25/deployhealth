# Security

Hard caps, SSRF, authorization, share links, security headers, logs and error reports, account
export and deletion, and the public pages that describe them (/security, /privacy, /terms,
security.txt). Read before changing a cap, anything that fetches a URL, a query's scoping, share
links, headers, anything that logs or reports errors, or those pages.

## Layout (core)

```
    src/ssrf.ts       SSRF guard: assertPublicUrl() on save, guardedLookup at connect time
```

## Hard caps

- **Hard caps** live in `packages/core/src/limits.ts` and hold for every account whatever its plan:
  100 endpoints per project and 500 per user (`createEndpoint`, which locks the owner's row so
  concurrent creates can't race past them), one check per hostname per 10 s across all users (the
  claim, see [worker.md](worker.md); per name, not per server: /security says different names for
  one server are spaced separately; with `CLAIM_WINDOW_MS` that is at most `MAX_CHECKS_PER_HOST_PER_CLAIM`
  (5) checks of a hostname per claim, which /security and the endpoint form state), at most `MAX_CLAIM_PER_OWNER` (50) of one owner's endpoints per claim, 5 MB ingest
  bodies (counted while streaming), 2,000 files / 20 MB fetched per pull request check
  (`createFetchBudget()`: `take(size)` per distinct path + blob before any download, `verify()`
  after), and `PR_CHECK_TIME_LIMIT_MS` (60 s) of scanning per pull request check (isolate.ts).
  Exceeding one throws `LimitExceededError`, whose message is safe to show.
  A pull request check stopped by a cap ("too large to check") or that couldn't run ("Couldn't be
  checked") is neutral even in strict mode, and GitHub counts neutral as passing; /security states
  this limit (github-app.md, "Strict mode's limit").

## SSRF

- **SSRF:** any URL the server or worker will fetch (endpoints, webhooks) must pass
  `assertPublicUrl()` when saved, and must be fetched through `apps/worker/src/guarded-http.ts`
  (`guardedRequest` / `guardedPost`, on `guardedLookup`), never plain `fetch`. The guard re-checks
  the resolved address at connect time, which covers redirects and DNS rebinding.
  **DNS** for both checks is `resolveHostAddresses()` (core `ssrf.ts`): A and AAAA asked in
  parallel on a `dns.promises.Resolver` (`DNS_QUERY_TIMEOUT_MS` 2 s, `DNS_QUERY_TRIES` 2), with
  `DNS_LOOKUP_DEADLINE_MS` (4 s) for the whole lookup. One family failing, timing out or answering
  nothing is fine when the other answers (only answered addresses are checked or connected to);
  no answer at all within the bound fails closed (`DnsTimeoutError`: no connection, and a save is
  refused with "Couldn't look up <host> in time"), while a name that doesn't exist still saves as
  before. The resolver doesn't read `/etc/hosts`, so `localhost` and `*.localhost` are refused up
  front. GitHub API calls (`githubFetch`) don't use it: they keep the same guard on the system
  resolver (`systemGuardedLookup`, getaddrinfo), pinned by `apps/worker/test/guarded-lookup.test.ts`.
  Saving endpoints (create and edit) is limited per user to `ENDPOINT_SAVES_PER_WINDOW` (30) per
  `ENDPOINT_SAVE_WINDOW_MS` (10 minutes), in memory (`lib/endpoint-save-limit.ts`, on
  `lib/rate-limit.ts`), checked before the lookup.
  The guard also refuses documentation ranges and every IPv6 address that carries or tunnels to
  an IPv4 one (`::/96`, `::ffff:0:0/96`, 6to4, Teredo, local-use NAT64; matched by hand, since
  `BlockList` checks IPv4 addresses against IPv6 rules too); a saved endpoint in a newly blocked
  range just fails its checks with the guard's message.
  `apps/worker/test/no-unguarded-http.test.ts` walks the repo and fails if any other non-test file
  contains `fetch(`, `http(s).request(`/`.get(`, axios, undici, `got(`, node-fetch, or imports
  `node:http(s)`/`http2`. Its allowlist names every exception with a reason (the guarded module,
  the CLI, the scanner's Ruby `ENV.fetch` pattern) and fails if an entry goes stale.
  **R2 (backups):** `r2Request` talks only to `<32-hex account id>.r2.cloudflarestorage.com` (or
  `.eu.`), https, no redirects, through the guarded lookup on the system resolver (a fixed host,
  like GitHub's); like `githubFetch` it reads response bodies, capped in memory
  (`MAX_R2_RESPONSE_BYTES`) or streamed to a file. Requests are signed with `aws4`; credentials
  never reach a log or an error message.
  **The one outbound request that isn't guarded:** Sentry's SDK sends error reports to the host in
  `SENTRY_DSN` with its own transport (`packages/db/src/sentry.ts`). That host is the operator's
  setting, never user input, and no file in the repo makes the request, so the walk doesn't see it.

## Authorization

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
  - Worker-only queries (`claimDueEndpoints`, `recordCheck`, `countDueEndpoints`,
    `alertWebhookTarget`) take ids the worker already holds and are never called by the web app;
    they're listed in [worker.md](worker.md) ("Worker-only queries").
  - Operator commands (`delete-user`, `stats` in packages/db) aren't owner-scoped either: they run
    only from a shell in the web container, aren't exported from the package and have no route.
    The account page's export and deletion are owner-scoped: `exportUserData(db, userId)`,
    `planOwnAccountDeletion` / `deleteOwnAccount(db, userId)` (deleteUser's `{ userId }`
    selector; the login and GitHub id selectors stay operator-only) and `userExists`.

## Share links

- **Share links:** `lib/share-link.ts`. Token = base64url(`v1.<clientId>.<YYYY-MM>.<expiry>`) + `.` +
  base64url(HMAC-SHA256). The key is `REPORT_SHARE_SECRET`, else HKDF-SHA256 of `AUTH_SECRET` with
  info `deployhealth-report-share`. Verify the signature (constant time) before parsing fields.
  Stateless, 90 days; rotating the key revokes every link. `/share/*` is rate-limited per IP in
  `middleware.ts` (Node runtime, 30/min, keyed on the last `X-Forwarded-For` hop).
- **What a share link shows:** the client's report and, under "Prepared by", the report owner's
  GitHub name (their login when they have no name); nothing else about the owner, and no commit
  links (`getClientReport`'s `preparedBy`; alerts-and-reports.md).

## Logs and error reports

- **Never values, tokens, webhook URLs or cookies in a log line or an error report.**
  `packages/db/src/redact.ts` (`@deployhealth/db/redact`; not in core, the published scanner):
  `redactText()` keeps a URL's scheme and host only (no userinfo, path or query) and replaces
  ingest tokens, GitHub and Slack tokens, JWTs, bearer credentials, cookie and authorization
  headers, secret-named pairs (`apiKey: …`), env assignments (`NAME=value`: the value), email
  addresses, 32+ hex characters (a full commit SHA included) and random-looking base64 runs with
  `[redacted]`. Every pattern is bounded, so it runs in linear time (`test/redact.test.ts` times
  hostile inputs).
- **Logs:** both servers call `installConsoleRedaction()` at startup (worker `index.ts`, before
  anything logs; web `instrumentation.ts` → `lib/observability.ts`, Node runtime), so every
  console line, Next's and libraries' included, is formatted, redacted and printed as one string.
  Call sites still log names, hosts and an error's name and code (`errorLabel()`), never a message
  that could quote a URL. No source file passes a raw error object to `console`
  (`apps/worker/test/log-redaction.test.ts` walks the repo; a pg error's own fields can quote rows).
- **Error reports** (`packages/db/src/sentry.ts`, on only with `SENTRY_DSN`): errors only (no
  tracing, profiling or OpenTelemetry setup), no default PII, no default integrations, no
  breadcrumbs, no local variables. `scrubErrorEvent()` runs as `beforeSend`: it removes the
  request's body, headers, cookies and query string (keeping the method and the redacted path), the
  user, breadcrumbs, source lines and frame variables, keeps only the runtime, OS and trace
  contexts, and redacts the message, exception values, tags and extras. Web reports
  `onRequestError` with the route pattern and method only (never the path a request used, which
  can hold a share token); the worker tags reports with the queue. Release: Railway's
  `RAILWAY_GIT_COMMIT_SHA`. No browser SDK: nothing reaches the client bundle or any public page.
  `test/sentry.test.ts` throws through the real SDK with a `dh_` token and a Slack webhook URL in
  the error's context and checks what the transport would have sent.

## Account export and deletion

- **/account** (signed in): "Export my data" (`GET /account/export`: `exportUserData`, JSON,
  `no-store`, at most `EXPORTS_PER_WINDOW` (5) per user per 10 minutes in memory; the demo user
  gets a 403 from `requireWritableUser()`), and "Delete my account" (`deleteMyAccount`: the guard
  first, then the typed GitHub login, then `deleteOwnAccount`, then sign-out onto
  `/account/deleted`). The export holds no token hashes or hints, no alert webhook URLs ("set"),
  no raw checks and no GitHub comment ids (`test/export.test.ts`).
- **Deletion record:** `deleteUser()` (both paths) inserts `account_deletions (github_id,
  deleted_at)` in its transaction, linked to nothing, pruned nightly after
  `ACCOUNT_DELETION_RECORD_DAYS` (35: `(BACKUP_RETENTION_WEEKS + 1) × 7`, the four weekly backups plus a week; `packages/db/src/retention.ts`), so a restore can re-apply
  deletions newer than the dump.
- **A session whose account is gone** (JWTs can't be revoked): `requireUser()` checks
  `userExists()` and redirects to `/account/signed-out`, which signs out only a session whose user
  no longer exists (so a link to it can't sign anyone out) and shows `/account/deleted`.

## Backups

- The backup service (worker.md) holds the only R2 credentials: a token scoped to the one backup
  bucket (Object Read & Write). Dumps hold the whole database, alert webhook URLs (which work like
  passwords), emails and token hashes included, never env values; R2 encrypts them at rest, they
  aren't encrypted again. The 4 newest weekly dumps are kept (`BACKUP_RETENTION_WEEKS`), so deleted
  data leaves every backup within about 4 weeks; `deletions.json` (GitHub ids and times only,
  ACCOUNT_DELETION_RECORD_DAYS) lets a restore re-apply deletions made after its dump. /privacy and
  /security state it from `BACKUPS_TEXT` (web `lib/legal.ts`).

## Security headers

- **Security headers** (`SECURITY_HEADERS` in `next.config.ts`, on `/:path*`, tested with Next's own
  matcher): nosniff, `strict-origin-when-cross-origin`, `X-Frame-Options: DENY` + CSP
  `frame-ancestors 'none'` (the only CSP directive for now: Next's inline scripts need nonces
  first), and a Permissions-Policy denying camera, microphone and geolocation. No HSTS in code: it's
  set at Cloudflare.

## /security, /privacy and /terms

- **/security** (public, linked from the footer) states what's stored and how checks and share
  links work, using the shared constants (`CHECK_TIMEOUT_MS`, caps, `SHARE_LINK_DAYS`) so it can't
  drift. Keep it true when behaviour changes (anything new that reads repositories goes there). The
  contact is `SECURITY_CONTACT_EMAIL`, else a private GitHub security advisory; the same contact
  goes into `/.well-known/security.txt` (RFC 9116, `Expires` 180 days out, rounded to the day;
  `no-store`: its URLs come from `PUBLIC_ORIGIN`, but without it they'd follow the request's host
  headers). Every absolute URL comes from `publicOrigin()` (web.md, "The public origin"), so a
  forged Host or X-Forwarded-Host can't change security.txt, the sitemap, canonical URLs, the
  Action snippet or share links.
- **/privacy and /terms** are static pages whose facts live in `lib/legal.ts` (operator and
  country, `LEGAL_LAST_UPDATED`, hosting region, subprocessors, deletion window,
  `CHECK_RETENTION_TEXT`) and `lib/auth-providers.ts` (`GITHUB_OAUTH_SCOPES`, `githubSignInReads()`,
  also shown on /login and /security). The contact is `securityContact()`. `test/legal.test.ts`
  checks /privacy and /security render the same retention and scope text, and the same
  `ERROR_REPORTS_TEXT`, `SELF_SERVE_DATA_TEXT`, `DELETION_RECORD_TEXT` and `BACKUPS_TEXT`. Sentry is a
  subprocessor. Bump
  `LEGAL_LAST_UPDATED` with any change to either page, and keep /privacy true to the code like
  /security.

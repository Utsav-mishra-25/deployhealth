# Security

Hard caps, SSRF, authorization, share links, security headers, and the public pages that describe
them (/security, /privacy, /terms, security.txt). Read before changing a cap, anything that fetches
a URL, a query's scoping, share links, headers, or those pages.

## Layout (core)

```
    src/ssrf.ts       SSRF guard: assertPublicUrl() on save, guardedLookup at connect time
```

## Hard caps

- **Hard caps** live in `packages/core/src/limits.ts` and hold for every account whatever its plan:
  100 endpoints per project and 500 per user (`createEndpoint`, which locks the owner's row so
  concurrent creates can't race past them), one check per hostname per 10 s across all users (the
  claim, above), at most `MAX_CLAIM_PER_OWNER` (50) of one owner's endpoints per claim, 5 MB ingest
  bodies (counted while streaming), 2,000 files / 20 MB fetched per pull request check
  (`createFetchBudget()`: `take(size)` per distinct path + blob before any download, `verify()`
  after), and `PR_CHECK_TIME_LIMIT_MS` (60 s) of scanning per pull request check (isolate.ts).
  Exceeding one throws `LimitExceededError`, whose message is safe to show.

## SSRF

- **SSRF:** any URL the server or worker will fetch (endpoints, webhooks) must pass
  `assertPublicUrl()` when saved, and must be fetched through `apps/worker/src/guarded-http.ts`
  (`guardedRequest` / `guardedPost`, on `guardedLookup`), never plain `fetch`. The guard re-checks
  the resolved address at connect time, which covers redirects and DNS rebinding.
  The guard also refuses documentation ranges and every IPv6 address that carries or tunnels to
  an IPv4 one (`::/96`, `::ffff:0:0/96`, 6to4, Teredo, local-use NAT64; matched by hand, since
  `BlockList` checks IPv4 addresses against IPv6 rules too); a saved endpoint in a newly blocked
  range just fails its checks with the guard's message.
  `apps/worker/test/no-unguarded-http.test.ts` walks the repo and fails if any other non-test file
  contains `fetch(`, `http(s).request(`/`.get(`, axios, undici, `got(`, node-fetch, or imports
  `node:http(s)`/`http2`. Its allowlist names every exception with a reason (the guarded module,
  the CLI, the scanner's Ruby `ENV.fetch` pattern) and fails if an entry goes stale.

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

## Share links

- **Share links:** `lib/share-link.ts`. Token = base64url(`v1.<clientId>.<YYYY-MM>.<expiry>`) + `.` +
  base64url(HMAC-SHA256). The key is `REPORT_SHARE_SECRET`, else HKDF-SHA256 of `AUTH_SECRET` with
  info `deployhealth-report-share`. Verify the signature (constant time) before parsing fields.
  Stateless, 90 days; rotating the key revokes every link. `/share/*` is rate-limited per IP in
  `middleware.ts` (Node runtime, 30/min, keyed on the last `X-Forwarded-For` hop).

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
  `no-store`, since its URLs come from the request's host headers).
- **/privacy and /terms** are static pages whose facts live in `lib/legal.ts` (operator and
  country, `LEGAL_LAST_UPDATED`, hosting region, subprocessors, deletion window,
  `CHECK_RETENTION_TEXT`) and `lib/auth-providers.ts` (`GITHUB_OAUTH_SCOPES`, `githubSignInReads()`,
  also shown on /login and /security). The contact is `securityContact()`. `test/legal.test.ts`
  checks /privacy and /security render the same retention and scope text. Bump
  `LEGAL_LAST_UPDATED` with any change to either page, and keep /privacy true to the code like
  /security.

PHASE 4.5 — Launch polish (before Show HN, target live by Sun 4 Oct)

Read CLAUDE.md first. Push existing work before you start.
Show me the file structure, any schema changes and the route list, wait for my go-ahead, then build.
Conventions unchanged: small conventional commits, relevant tests after each change,
full suite at the end, then a done / stubbed / decisions summary. Push only when I say so.

Context: a review of the live site as a signed-out visitor found that / redirects to a bare
sign-in card, the demo's headline alert reads "down for 10h" instead of "4m after deploy", the
demo shows "No pull requests checked yet", pages overflow sideways on phones, /privacy and
/terms 404, there's no favicon or link-preview metadata, and no security headers are sent.
This phase fixes exactly that. No new features, no billing, no pricing numbers anywhere.

Hard rules for every public page in this phase: no external assets (fonts, scripts, images,
analytics), server components unless interactivity is unavoidable, works at 375 px wide with no
horizontal page scroll, and no new env vars unless you list one as a decision.

PART 1 — What a stranger sees

1. Landing page at /
Goal: a signed-out visitor understands the product in one screen and can reach the demo in one click.
- Signed-in users keep going to /clients exactly as today. Signed-out users get the landing page
  (no redirect to /login).
- Hero: the correlation alert rendered like the real alert banner component:
  "Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars:
  REDIS_URL, STRIPE_KEY". Under it one line: "deployhealth checks your env vars on every push and
  pull request, watches your endpoints, and tells you which deploy broke what."
  Primary button "See the live demo" (/demo), secondary "Sign in with GitHub".
- Three short blocks: Env checks on every push and PR (names and file:line, never values) ·
  Uptime with deploy-aware alerts (Slack/Discord) · Client reports and handoff docs.
- A "How it works" row of three steps: add the GitHub Action → add your endpoints → get alerts
  that name the deploy (plus: install the GitHub App for pull request checks).
- A trust strip: "Never reads your env values or response bodies" · "Scanner is MIT, 12 KB, zero
  dependencies" · "Self-hostable" with links to /security and the repo.
- "Free while in beta." No prices, no pricing table.
- Indexable (no noindex on / ). Keep /share/* noindex as today.

2. Demo that tells the story at any hour
- The demo incident must look fresh whenever someone opens it: at any time, the b52952e deploy is
  between roughly 10 and 45 minutes old and Acme API's "Down for" is under an hour.
  Default approach: run reseed-demo every 30 minutes instead of nightly (still one transaction,
  still on worker start), with seed timestamps relative to `now` as today. If you see a cheaper
  or safer approach, propose it as a decision.
- Make sure reseeding can't produce a moment where /demo errors or shows empty data mid-reseed.
- Seed sample pull request checks on the demo's acme-storefront project so the "Pull requests"
  section is populated. Find out why the existing seed's PR data doesn't show there today and say
  so in the summary. Three rows:
  (a) a coding-agent PR (Claude) that adds REDIS_URL and STRIPE_KEY without declaring them in
      .env.example, conclusion neutral;
  (b) a human PR that renames SENDGRID_KEY to EMAIL_API_KEY and updates .env.example, clean;
  (c) a PR that commits apps/web/.env.local and adds one secret-shaped string, strict mode, failure.
  Demo rows must not link to github.com PRs that don't exist: render them without outbound links
  or with a clearly-labelled "sample" marker.
- The demo banner copy becomes: "Live demo. Clients, deploys and pull request checks are sample
  data, read-only. The Acme API check and its alert are live: the worker checks it every minute."
- Human step (prepare, then wait): I may give you one public URL of a real deployhealth PR comment
  to link as "See a real PR comment". If I don't, leave that link out.

3. Mobile
- /demo (clients overview): on narrow screens the Uptime status ("Down", "Acme API down for …")
  must be visible without horizontal scrolling. Default: stacked rows/cards below 640 px with the
  status badge next to the project name.
- Demo project page currently measures 560 px wide at a 375 px viewport. Find the overflowing
  elements (likely long URLs, the endpoint header row or tables) and fix them: wrap/break long
  URLs and SHAs, keep wide tables inside their own horizontally scrollable container.
- Check the same on: landing, /login, /demo, demo project, demo client, handoff page, monthly
  report page, /share/* report, /security, /privacy, /terms, and the signed-in clients/project/
  settings pages.

4. Privacy policy and terms
- /privacy and /terms, static pages, linked in the footer next to Security and Source on GitHub.
- Privacy content must match what the code actually does (mirror /security, same constants):
  what we store (GitHub id, login, name, email and avatar from sign-in; variable names and
  file:line; endpoint URLs and check results; alerts and webhook host; token hashes; PR check
  summaries), what we never store (env values, response bodies, file contents, secret strings),
  retention (raw checks 30 days, daily totals kept; App uninstall deletes its PR checks), where
  (Railway, Singapore region), subprocessors (Railway: hosting and database; Cloudflare: DNS and
  proxy; GitHub: sign-in and the App), no analytics or ad trackers, cookies (session cookie only),
  how to get data deleted (email the contact; we delete within 30 days; self-serve deletion is
  planned), and the contact (reuse securityContact()).
  State exactly what the GitHub OAuth scopes are as configured in lib/auth-providers.ts; if the
  scopes include access to private emails, the privacy page and /security must say so.
- Terms: plain English, short. Beta service provided as is, no uptime SLA; acceptable use (only
  monitor endpoints you own or are authorised to check; no load testing or probing third parties
  through the service); we may suspend abusive accounts; you keep ownership of your data; the code
  licences (FSL-1.1-MIT for the app, MIT for packages/core) with self-hosting allowed; limitation
  of liability; changes to terms with notice; contact.
- Human step (prepare, then wait): I'll give you the operator name and country to show on both
  pages (public information only). Use a clear placeholder until I do and list it in the summary.
- Both pages show "Last updated: <date>".

5. Metadata, favicon, titles
- A simple SVG favicon/app icon (inline in the repo, no external asset), matching the wordmark's
  green.
- Site-wide metadata: metadataBase from the existing app-url helper, Open Graph and Twitter card
  (summary_large_image) with title "deployhealth" and the existing description.
- An Open Graph image generated at build or request time (next/og or a static PNG in the repo)
  showing the alert sentence on the brand background. No external fonts.
- Page titles: project pages "<project> · deployhealth", client pages "<client> · deployhealth",
  handoff "Handoff · <project> · deployhealth", reports "Report · <month> · deployhealth".
  /share/* keeps a generic title ("Monthly report · deployhealth") so client names don't end up
  in link-unfurl caches.
- Add a sitemap with /, /demo, /security, /privacy, /terms. Don't fight Cloudflare's managed
  robots.txt; tell me in the summary if an app robots route would conflict with it.

6. Sign-in page copy
- Under "Sign in with GitHub": one line stating exactly what sign-in reads (derived from the
  configured scopes) and "No repository access. The optional GitHub App is separate."
- Keep the "See a live demo" link.

7. Security headers
- Send on every route via next.config: X-Content-Type-Options: nosniff; Referrer-Policy:
  strict-origin-when-cross-origin; X-Frame-Options: DENY plus
  Content-Security-Policy: frame-ancestors 'none' (frame-ancestors only in this phase);
  Permissions-Policy: camera=(), microphone=(), geolocation=().
- Default: no HSTS in code (I'll enable it in Cloudflare) and no script/style CSP yet (Next's
  inline scripts need nonces; that's Phase 6). Propose otherwise as a decision if you disagree.
- Make sure nothing breaks: the printable handoff and report pages, the GitHub webhook, ingest,
  /share/*, the Markdown download.

Tests:
- e2e: signed-out / shows the landing page and its demo link works; signed-in / goes to /clients.
- e2e: at 375×812, document.documentElement.scrollWidth <= clientWidth on every page listed in 3
  (public ones signed out, the rest as the dev user).
- e2e: /demo acme-storefront shows the three sample PR checks; no demo PR row links to github.com.
- unit: seed puts the demo deploy within the freshness window relative to `now`; reseed schedule
  constant is what the worker registers.
- unit (extend next-config.test.ts): every header above is configured for all routes, including
  /api/*.
- The read-only-demo guard test and isolation tests still pass untouched.
- /privacy and /security agree: a test that both render the same retention constant and the same
  scope description.

Docs: README (landing page mention, privacy/terms links, demo reseed cadence), CLAUDE.md (landing
route rules, public-page rules above, headers, reseed cadence, where legal page content comes
from), docs/deploy-railway.md only if the worker schedule change needs any dashboard step.

Stop after Part 1 with the summary, a phone-width screenshot of /, /demo and the demo project
page, and the human steps I still owe (operator name/country, optional PR comment URL, Cloudflare
HSTS, redeploy check).

PART 2 — Quieter first scan (only when I say "go Part 2"; it needs a CLI release)

Goal: a first scan of a typical real repo shows real problems, not noise.
- Default ignore list for names the platform or runtime always provides: NODE_ENV, CI, and
  platform-injected prefixes (e.g. VERCEL_*, RAILWAY_*, GITHUB_*, RENDER_*, FLY_*). Users can
  still see them with a flag; propose the exact list as a decision.
- References with an inline default are not MISSING: JS `process.env.X ?? …` / `|| …` on the
  same line, Python `os.getenv("X", default)` / `os.environ.get("X", default)`, Ruby
  `ENV.fetch("X", default)` / `ENV.fetch("X") { … }`. Propose how they surface instead (e.g. listed
  in variables as optional) and keep the ingest contract backward compatible with 0.1.0 payloads.
- Scan .mjs, .cjs, .mts, .cts. Read .env.development, .env.production, .env.test and their .local
  variants as env files.
- A scope with code references but no env file at all shows one notice ("No .env.example here:
  N variables referenced") in the UI instead of N MISSING rows, and the handoff's variable list is
  offered as a copyable .env.example.
- The worker's PR check picks this up from packages/core on deploy; the Action needs a new CLI
  version.
Human step (prepare, then wait): I publish the new CLI version from packages/core/npm with 2FA and
paste back only the published version; then you update PUBLISHED_CLI_VERSION, the snippet, README
and this repo's self-scan workflow.
Tests: fixtures for each default form (JS, Python, Ruby; Go has none), the ignore list, new extensions and
env file names, a no-env-file scope, and an ingest test that a 0.1.0-shaped payload still works.
Stop after Part 2 with the summary and the publish step.

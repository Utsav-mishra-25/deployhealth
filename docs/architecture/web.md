# Web app (`apps/web`)

The Next.js app: pages, auth, public pages, metadata, Markdown, health checks. Read before changing
anything under `apps/web` (security-related pages and headers are in [security.md](security.md),
the demo in [demo-and-seed.md](demo-and-seed.md), ingest in [ingest-and-cli.md](ingest-and-cli.md),
the GitHub webhook in [github-app.md](github-app.md)).

## Layout

```
apps/
  web/                Next.js 15 App Router + Tailwind. UI, Auth.js, POST /api/ingest/scan
    src/env.ts        the ONLY place web reads process.env (by name, validated lazily)
    src/auth.ts       Auth.js v5: GitHub OAuth + dev-only dev login, JWT sessions, no adapter
    src/middleware.ts rate limits for /share/* and /api/health/worker (Node runtime, in memory)
    src/instrumentation.ts  at startup: one error if PUBLIC_ORIGIN is invalid, or missing in production; then
                      (Node runtime) lib/observability.ts: redacted console and Sentry; onRequestError
    src/lib/          ingest handler, validation (zod), guard (read-only demo), demo owner, paths,
                      handoff loader, share-link signing, rate limiter, auth providers (+ the OAuth
                      scopes and what sign-in reads), formatting, github-webhook.ts (signature,
                      dedupe, per-installation limit, events), jobs.ts (send-only pg-boss client),
                      read-body.ts (capped streaming body reader), legal.ts (operator, hosting,
                      subprocessors, retention wording), titles.ts (page titles), landing.ts, brand.ts,
                      worker-health.ts (the deep health check's response), github-app.ts (project
                      prefill and safe return paths for the App's next steps), onboarding.ts (the
                      first-run checklist, the install link's `state` allowlist and return paths),
                      repo-coverage.ts (browser-safe: whether the user's own installations cover a
                      repository, and the settings link to fix it), setup-copy.ts, security.ts
                      (security.txt and the security contact), marketing.ts (the public pages' copy: hero, who it's
                      for, how it works, FAQ, pricing, the demo guide, landing and /pricing metadata),
                      site-nav.ts (the header's public links and the share-page flag), app-url.ts (`publicOrigin()`: every
                      absolute URL, from PUBLIC_ORIGIN), db.ts (the shared database handle), project-status.ts
                      (one status per project, its reasons, ordering, the summary line),
                      deploy-changes.ts (a deploy's "what changed" and outage lines, commit links),
                      observability.ts (redacted logs, Sentry, request errors by route pattern),
                      account.ts (the account page's wording, export limit and paths)
    src/views/        page bodies shared by signed-in and /demo routes: clients overview, client,
                      project, handoff, report (props: ownerId/data, paths, readOnly)
    src/app/          / (landing when signed out, else → /clients), /login, /clients, /clients/new,
                      /clients/[slug](/edit, /report), /projects/new, /projects/[id] (+ endpoint
                      actions, /settings, /handoff, /handoff.md), /demo/... (read-only mirror),
                      /share/reports/[token], /api/demo/broken, /pricing, /security, /privacy, /terms and
                      /.well-known/security.txt (public), /api/health (Railway's, no database),
                      /api/health/worker (deep check), /api/github/webhook (GitHub App),
                      /github/installed (the App's setup URL), /account (+ /export, actions, /deleted,
                      /signed-out); icon.svg, opengraph-image.tsx (+
                      twitter-image), sitemap.ts, not-found.tsx (every 404)
    src/components/   badges, breadcrumb, endpoints section, recent checks (5, then Show all checks),
                      section links (the project page's "Findings · Deploys · …"), latency chart (Recharts, client-only),
                      SafeMarkdown, demo banner, demo guide, print/share buttons, report toolbar,
                      alert card, landing, public-nav, pricing, faq, prose-page (layout of
                      /security, /privacy, /terms), onboarding-checklist, install-confirmation,
                      repo-coverage-notice, project-getting-started, setup-order, account-data (the
                      account page's export and delete sections)
    public/landing/   demo-clients.png: the landing page's screenshot (committed, not generated)
    e2e/              Playwright on `next build` + `next start`: public demo (+ handoff, report) and the
                      signed-in flow (+ share link); onboarding.spec.ts (the first run on a fresh
                      dev account); mobile.spec.ts (375 px), a11y.spec.ts (axe); helpers.ts
                      (projects, tokens, signed webhooks, the dev reset, axe and 375 px checks);
                      session.ts (the dev user's minted session; development.md)
    railway.json      documentation only: the Railway build/deploy fields set by hand in the dashboard
```

And in core, for client components:

```
    src/browser.ts    `@deployhealth/core/browser`: the pure subset for client components
```

## Conventions

- **Public pages** (`/`, `/login`, `/demo/...`, `/share/*`, `/pricing`, `/security`, `/privacy`, `/terms`,
  `/docs/...`, `/github/installed` signed out, and the 404): no
  external assets (fonts, scripts, images, analytics), server components unless interactivity is
  unavoidable, and no sideways scroll at 375 px (`e2e/mobile.spec.ts`; wide tables go inside their
  own `overflow-x-auto` box, or `.doc-scroll` on printable pages, which prints full width; long
  names and paths get `break-all`/`break-words`). No new env vars for them without a decision.
- **Accessibility:** every public page, the signed-in /clients, a client page, a project page with
  a deploy, its settings page and a shared report have no serious or critical axe violations (WCAG 2.1 A/AA tags; `e2e/a11y.spec.ts`; add new
  public pages there). Every first-run screen (the checklist home, the new-project form with and
  without the picker, a project before any data, its settings, /github/installed signed in) gets
  axe and the 375 px check in `e2e/onboarding.spec.ts` (`expectFirstRunScreen`). Small text and buttons with white text use emerald-700, never emerald-600
  (3.65:1 on white); muted text on white or gray-50 is gray-500, never gray-400. The icon and the
  OG image keep `BRAND_GREEN` (emerald-600): a graphic and large text need only 3:1.
- **The header** (root layout): signed out, the logo then `PublicNav`: Demo (only with
  `DEMO_PUBLIC=1`) · Docs · Pricing · Sign in with GitHub (a link to /login, no inline action). No
  JavaScript and no menu: at 375 px it wraps under the logo. Signed in, the user's login, Account
  (/account) and Sign out instead. On `/share/*` (a report a client opens) there is no nav, only the logo:
  `middleware.ts`, which already runs there, sets `HIDE_PUBLIC_NAV_HEADER` on the request and the
  layout reads it (forging it elsewhere only hides the nav for whoever sends it). The footer links
  Docs, Pricing, Security, Privacy, Terms, Status and the source (`footerLinks()` in
  `lib/site-nav.ts`); on `/share/*`, signed in or not, only Privacy and Terms (the same header flag). Status links to the public status
  page in `STATUS_PAGE_URL` (decided in Phase 9; https only, parsed by `parseStatusPageUrl()` in
  `lib/site-nav.ts`, never failing a page): unset or unusable, there's no link, and an unusable
  value logs one error at startup.
- **`/`** is the landing page for signed-out visitors (indexable) and redirects signed-in users to
  /clients. Freelancer first, in this order (`test/landing.test.ts` pins it): the hero (headline,
  subline, See the live demo (only with `DEMO_PUBLIC=1`) and Sign in with GitHub, the docs link,
  "Free during the beta."); one committed screenshot of /demo's clients list
  (`public/landing/demo-clients.png`, 2x, light, from a production build with demo data, under
  200 KB, a plain `<img>` with width, height and alt; retake it when the list's look changes;
  with `DEMO_PUBLIC=1` it links to /demo, the link named "Open the live demo: " plus the alt);
  "What an alert looks like (live from the demo)", the example alert built by
  `alertOpenedMessage()` with the demo incident's values (`lib/landing.ts`, tested against the
  seed), labelled "Alerts like this go to Slack or Discord." (the demo has no webhook, so never
  "posted"); who it's for (freelancers and agencies; small dev teams, with the Dependabot comparison:
  a comparison only, no logos or marks, nothing implying an affiliation); how it works in the real
  setup order (the App, no token; your sites; optionally the Action); pricing; the FAQ as plain
  `<details>` (the stack answer is `FAQ_STACK_SENTENCE`: one line, its "Supported today" list
  pinned to core's `SUPPORTED_LANGUAGES`; `LANGUAGES_SENTENCE` isn't on the landing page); the
  trust strip. The bundle
  size it states is `CLI_BUNDLE_KB` (core), pinned to the built CLI by `test/npm-package.test.ts`.
  All the copy is in `lib/marketing.ts`.
- **Pricing** (`/pricing`, and the landing page's section, both `PricingPlans`): only what's true
  today: "Free during the beta: everything you see in the demo.", then the planned prices as names
  and prices only (Freelancer $15/month, Studio $29/month) and "Beta users get advance notice and an
  early-user price." No limits table and no features that aren't built (email alerts, branded
  reports, seats); `test/marketing.test.ts` checks. In the sitemap, linked from the header and the
  footer. Change a price in `PRICING` and the FAQ answer and the description follow.
- **The 404** (`app/not-found.tsx`, every unknown path and `notFound()`): "Page not found" in the
  site's style with links to Home, Demo (with `DEMO_PUBLIC=1`) and Docs; nothing about why.
- **Docs pages** (`/docs`, `/docs/nextjs`, `/docs/laravel`, `/docs/spring-boot`; the slugs are
  `DOCS_STACK_SLUGS` in core, shared with the worker's PR comment footer): static server components
  rendered from `lib/docs-pages.ts`, no session or user data, indexed, canonical URLs (resolved
  against `metadataBase`, from `publicOrigin()` like the sitemap), titles under
  60 characters and descriptions under 155, in the sitemap, linked from the landing page and the
  footer. Each stack page is problem-first ("How to catch a missing env var in <stack> before it
  reaches production"): read forms, defaults and OPTIONAL, skips, known limits, setup, the no-signup
  `npx -y deployhealth-scan --dry-run`. **Every example lives in `lib/docs-pages.ts` with exactly what
  the scanner reports for it** (reads with file:line and OPTIONAL, MISSING, UNUSED), and
  `test/docs-pages.test.ts` scans each one (`selectTreeFiles` then `scanFiles`, as the App does):
  change the scanner and a page that no longer matches fails. Unknown stacks 404
  (`dynamicParams = false`).
  Under the headline, one line names the languages the scanner reads: `LANGUAGES_SENTENCE` (core
  `languages.ts`), the same line as the one opening the README's Known limitations and the npm
  README's (tests pin all three).
- **Setup copy** is worded once in `lib/setup-copy.ts` (browser-safe: `TokenReveal` is rendered by
  a client form), in the landing page's order: **Pull request checks (GitHub App)** (the App plus a
  project for the exact owner/repo; no token, no secret, no variable), then **Optional: deploy
  history (GitHub Action)** (deploy history and alerts that name the deploy: the Action plus the
  project's token as the repository secret `DEPLOYHEALTH_TOKEN`, with the GitHub path to the
  Secrets tab and why not a Variable or an environment secret: `components/secret-steps.tsx`). The
  settings page is in that order, then Client, alerts & handoff; "Try the scan locally first" sits
  inside the optional section. `/github/installed` shows the three steps of `HOW_IT_WORKS`
  (`SetupOrder`), never the token steps. Short copy, no wizard.
- **No token at creation.** Creating a project redirects to its page (`?created=1`, one line:
  "Added <name>."); the hashed token the column needs is never shown. The token appears only when
  the user asks for it in settings: **Create token** while no deploy has been reported (the same
  `regenerateTokenAction`), **Regenerate token** after, each with a confirm. A token value
  appears only in `TokenReveal`'s box, once (`test/setup-copy.test.ts`).
- **First run** (`lib/onboarding.ts`, `components/onboarding-checklist.tsx`; owner-scoped data
  from `getOnboardingState`). /clients shows "Get set up" until every required step is done:
  1. Install the GitHub App (done: a non-suspended installation; the link is GitHub's install
  page with `state=clients`; "Not available on this deployment" without `GITHUB_APP_SLUG`, which
  then doesn't hold the checklist open), 2. Add a project for a repo (done: one project; the
  repositories the App can see without a project are offered, pre-filled; when the user has an
  installation and a project's repository isn't covered, "N project(s) aren't covered by the App:
  <names>" links to `/github/installed#not-covered`), 3. Add a site (a URL to watch) (done: one
  endpoint; links to the newest project's `#add-endpoint`), 4. Choose where alerts go ("Down
  alerts go to Slack or Discord. Email is coming."; done: any project has an alert webhook; links
  to `/projects/<id>/settings#client-alerts` of the oldest project with an endpoint and no webhook;
  before any endpoint, "Alerts are for sites: add one first (step 3)."), and "Optional: deploy
  history with the Action" in a closed `<details>` (done: one deploy). Step 4's data comes from
  `lib/alert-destination.ts`, through the owner-scoped `getProjectForOwner` and
  `listEndpointsForOwner` (no list query returns the webhook): only a boolean and a project id
  reach the page, never the URL (`e2e/onboarding.spec.ts` checks /clients). A project's settings
  page with endpoints and no webhook says "Alerts for this project have nowhere to go yet." at the
  top. Titles and bodies of steps 1, 3 and the
  optional one are `HOW_IT_WORKS`'s, so the app and the landing page can't drift. With no
  clients, the home's heading is "Projects", there's no "New client" button and no "No client"
  group; after the first project a line offers "Group projects by client (optional)", and the
  new-project form shows the Client field. Breadcrumbs say "Projects / <name>" until there's a
  client.
- **New project** picks from the repositories the user's installations cover without a project
  (`reposWithoutProject`; "Another repository…" types one), fills the name from the repository,
  and says as you type when the App doesn't cover it (`RepoCoverageNotice`: installed on the
  owner but not selected → the installation's settings page, where Repository access is;
  not on that account → install it there; suspended → unsuspend). An installation with "All
  repositories" covers every repository of its account (`repoCoverage`, the same rule as the
  database's `getGithubAppStatus` and `findPrCheckTarget`).
- **A project before any data** (signed in, no scan): "What shows up here" instead of empty
  tables (`ProjectGettingStarted`): pull request checks first (open a pull request; or the
  coverage notice; or checks are off), then "Add a site (a URL to watch)", then "Optional: deploy
  history". One-line legends explain MISSING, UNUSED and MISMATCH under the counts
  (`FindingsLegend`) and Undeclared above the pull request table. On the project lists, "Not set
  up" says "Waiting for the first pull request check" or "GitHub App not installed on this repo"
  when the user's coverage is known (`notSetUpReason`; the demo keeps the generic line).
- **Project lists** (/clients, a client's page, /demo and /demo/clients/…): one status per project
  from `projectStatus()` (`lib/project-status.ts`, whose comment names every field it reads):
  **Down** (an open alert), **Needs attention** (MISSING or MISMATCH in the latest deploy's latest
  scan, a scope with no env file reading non-optional variables, an open pull request whose latest
  check flagged undeclared env vars, a committed env file or a secret, or an endpoint failing with no
  alert yet), **Not set up** (no scan and no pull request check) and **Healthy**. UNUSED never
  changes the status but is listed. Rows show the status as a text label (colour only repeats it),
  then non-zero findings and flags only ("3 missing · 1 mismatch · 1 open PR: committed env file,
  secret-shaped string": flagged open pull requests are one reason, counted once each, with the
  kinds they flagged), each linking to its section of
  the project page; Healthy rows add "checked <time>" (the later of the latest scan and pull request
  check). Projects sort worst first, then by name; client groups by their worst project, then name,
  "No client" last. One line on top: "2 of 5 projects need attention · 1 down" (`statusSummary()`).
  /clients and a signed-in client page pass the same `appCoversFor(installations, appSlug)`
  (`lib/onboarding.ts`) to `rankProjects`, so a project's status and reasons read the same on both.
- **The project page**, in this order: the open alert, the latest scan's counts, Findings, Deploys,
  Pull requests, Endpoints (before any data: "What shows up here" in the counts' place, its copy
  unchanged). Under the title, links to those sections in page order
  (`projectSectionLinks()` in `components/section-links.tsx`): only the sections the page renders
  (no scan: no Findings or Deploys; checks off with none recorded: no Pull requests), and no row
  for fewer than two. Each endpoint shows its 5 latest checks (`RECENT_CHECKS_SHOWN`); the rest of
  the 20 the query returns are inside a closed `<details>` "Show all checks".
- **Findings say what to do** (`findingAction()` in core `handoff.ts`), in a "What to do" column on
  the project page and after each open finding in the handoff (page and Markdown): MISSING
  "Declare it in <scope>/.env.example and set it on your host" (the deepest env scope containing
  the file; "the .env.example for its code" for scans without scopes), UNUSED "Remove it from
  <env file>, or ignore it", MISMATCH "Add it to <the env file it's absent from>" (usually
  `.env.example`). Names and paths only.
- **Deploy history** (project page, `listDeployHistory` in db): each row says what that deploy's
  latest scan changed against the previous scanned deploy's ("+1 missing: REDIS_URL · fixed 1
  unused: OLD_FLAG", "no change", "first scan", "not scanned"; names capped like alerts), and the
  deploy an outage followed says so in plain text ("Outage started 4m after this deploy (Acme API),
  still down"). Commits link to `https://github.com/<repo>/commit/<sha>`, except on /demo (made-up
  repositories). There is no source column (`deploys.source` stays in the schema and shows nowhere).
  The latest scan's counts are the cards at the top of the page, not repeated per row.
- **Project page notices:** "The last scan found no env var references. deployhealth reads JS/TS,
  Python, Go and Ruby." (`NoReferencesNotice`) shows when the displayed scan recorded its env
  scopes (CLI 0.2.0+) and referenced no variable at all (`ScanDetail.noEnvVarReferences`); older
  scans show nothing. A pull request check that's neutral with nothing flagged reads "Not checked"
  (a can't-check run; `prResult`).
- **The public origin:** every absolute URL (security.txt, the sitemap, `metadataBase` and so
  canonical and Open Graph URLs, the Action snippet on the settings page, after creating a project
  and in the handoff, share links) comes from `publicOrigin()` / `publicOriginFor(headers)` in
  `lib/app-url.ts`: `PUBLIC_ORIGIN` (an origin only; one trailing slash is dropped; parsed by
  `parsePublicOrigin()`, never by `env.ts`'s validation, so it can't fail the environment; not an
  Auth.js variable, so sign-in still follows the request's host with `trustHost`). Unset or
  invalid, it falls back to the request's Host / X-Forwarded-Host, and `instrumentation.ts` logs
  one error at startup naming the variable and what's wrong (an invalid value in any mode, a
  missing one in production only); pages never fail over it. It always reads the request headers, so the pages
  using it render on request as before, never prerendered with build-time env.
  `test/public-origin.test.ts` and the e2e spoof test check a forged Host or X-Forwarded-Host
  never wins when it's set.
- **Metadata:** the root layout sets `metadataBase` from `publicOrigin()` and generic Open Graph / Twitter
  (`summary_large_image`) cards titled "deployhealth" on every page, so link previews never carry a
  client's name. The landing page alone sets its own title, description and Open Graph / Twitter
  title and description, from its headline (`LANDING_PAGE_METADATA`); /pricing its title and
  description. `app/opengraph-image.tsx` (next/og, its bundled font, rendered at build) is the
  preview: the landing headline on the brand green, with the headline as its alt. Page titles come from `lib/titles.ts`: "<project> · deployhealth", "Handoff · <project>
  · …", "<client> · …", "Report · <Month YYYY> · …", with "Live demo" before the site name on
  /demo; `/share/*` stays "Monthly report · deployhealth" and noindex. `sitemap.ts` lists the
  public pages; there is no robots route (Cloudflare manages robots.txt).
- **Untrusted Markdown** (deploy notes) renders only through `SafeMarkdown`: react-markdown with
  `skipHtml`, images removed, external links `rel="noopener noreferrer"`. Never add rehype-raw.
- **Printable pages** (handoff, report) use print CSS (`print:hidden`, `.doc-section`) and no
  external assets; the browser's Save as PDF is the PDF path. They state "All times UTC".
- **Client components** import only from `@deployhealth/core/browser` (the main entry pulls in
  `node:fs` / `node:crypto`). Type-only imports from the main entry are fine.
- **The dev login** ("Continue as dev user", provider `dev`, signs in as the writable `dev` user,
  `github_id = -2`) is registered only when `AUTH_DEMO_LOGIN=1` **and** `NODE_ENV !== 'production'`
  (`lib/auth-providers.ts`; asserted in `test/auth-providers.test.ts`). Don't add other gates
  elsewhere; keep it in that one function. It never signs in as the read-only demo user.
- **Health checks:** `/api/health` is Railway's deploy healthcheck: it never touches the database,
  logs nothing and isn't rate-limited (keep it that way). `/api/health/worker` is the deep check for external monitors: 200
  `{"ok":true}` when `check-endpoints` finished a run in the last 3 minutes
  (`WORKER_HEARTBEAT_MAX_AGE_SECONDS`, compared on the database clock), else 503 `{"ok":false}`,
  also on a database error. Nothing else in the body (no counts, names, hosts or timestamps),
  `no-store`, `X-Robots-Tag: noindex`, not in the sitemap, and rate-limited per IP in
  `middleware.ts` (30/min, its own window, same `clientIp()` as /share). /security doesn't list
  routes, so it isn't there. Monitor setup: `docs/deploy-railway.md` step 9.
- **The account page** (`/account`, signed in): "Export your data" (a plain link to
  `/account/export`, `download`) and "Delete your account" (what goes, with counts from
  `planOwnAccountDeletion`; what it means for clients, `DELETION_CONSEQUENCES`; a plain form whose
  typed GitHub login confirms it; no JavaScript). Both live in `components/account-data.tsx`, so
  they can move to whichever account or settings page the app has. The dev user sees the export
  and "can't be deleted here". `/account/deleted` is public and noindex; `/account/signed-out` is
  where `requireUser()` sends a session whose account is gone (security.md). In the a11y and
  375 px checks.

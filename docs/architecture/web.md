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
    src/instrumentation.ts  at startup: one error if PUBLIC_ORIGIN is invalid, or missing in production
    src/lib/          ingest handler, validation (zod), guard (read-only demo), demo owner, paths,
                      handoff loader, share-link signing, rate limiter, auth providers (+ the OAuth
                      scopes and what sign-in reads), formatting, github-webhook.ts (signature,
                      dedupe, per-installation limit, events), jobs.ts (send-only pg-boss client),
                      read-body.ts (capped streaming body reader), legal.ts (operator, hosting,
                      subprocessors, retention wording), titles.ts (page titles), landing.ts, brand.ts,
                      worker-health.ts (the deep health check's response), github-app.ts (project
                      prefill and safe return paths for the App's next steps), security.ts
                      (security.txt and the security contact), marketing.ts (the public pages' copy: hero, who it's
                      for, how it works, FAQ, pricing, the demo guide, landing and /pricing metadata),
                      site-nav.ts (the header's public links and the share-page flag), app-url.ts (`publicOrigin()`: every
                      absolute URL, from PUBLIC_ORIGIN), db.ts (the shared database handle), project-status.ts
                      (one status per project, its reasons, ordering, the summary line),
                      deploy-changes.ts (a deploy's "what changed" and outage lines, commit links)
    src/views/        page bodies shared by signed-in and /demo routes: clients overview, client,
                      project, handoff, report (props: ownerId/data, paths, readOnly)
    src/app/          / (landing when signed out, else → /clients), /login, /clients, /clients/new,
                      /clients/[slug](/edit, /report), /projects/new, /projects/[id] (+ endpoint
                      actions, /settings, /handoff, /handoff.md), /demo/... (read-only mirror),
                      /share/reports/[token], /api/demo/broken, /pricing, /security, /privacy, /terms and
                      /.well-known/security.txt (public), /api/health (Railway's, no database),
                      /api/health/worker (deep check), /api/github/webhook (GitHub App),
                      /github/installed (the App's setup URL); icon.svg, opengraph-image.tsx (+
                      twitter-image), sitemap.ts, not-found.tsx (every 404)
    src/components/   badges, breadcrumb, endpoints section, latency chart (Recharts, client-only),
                      SafeMarkdown, demo banner, demo guide, print/share buttons, report toolbar,
                      alert card, landing, public-nav, pricing, faq, prose-page (layout of
                      /security, /privacy, /terms)
    public/landing/   demo-clients.png: the landing page's screenshot (committed, not generated)
    e2e/              Playwright on `next build` + `next start`: public demo (+ handoff, report) and the
                      signed-in flow (+ share link); mobile.spec.ts (375 px), a11y.spec.ts (axe);
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
  public pages there). Small text and buttons with white text use emerald-700, never emerald-600
  (3.65:1 on white); muted text on white or gray-50 is gray-500, never gray-400. The icon and the
  OG image keep `BRAND_GREEN` (emerald-600): a graphic and large text need only 3:1.
- **The header** (root layout): signed out, the logo then `PublicNav`: Demo (only with
  `DEMO_PUBLIC=1`) · Docs · Pricing · Sign in with GitHub (a link to /login, no inline action). No
  JavaScript and no menu: at 375 px it wraps under the logo. Signed in, the user's login and Sign
  out instead. On `/share/*` (a report a client opens) there is no nav, only the logo:
  `middleware.ts`, which already runs there, sets `HIDE_PUBLIC_NAV_HEADER` on the request and the
  layout reads it (forging it elsewhere only hides the nav for whoever sends it). The footer links
  Docs, Pricing, Security, Privacy, Terms and the source.
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
  `languages.ts`), the same line as the README's opening and the npm README's (tests pin all three).
- **Setup copy** is worded once in `lib/setup-copy.ts` (browser-safe: `TokenReveal` is rendered by
  client forms): two options, **Pull request checks** (the App plus a project for the exact
  owner/repo; no token, no secret, no variable) and **Deploy history and alerts** (the Action plus
  the ingest token as the repository secret `DEPLOYHEALTH_TOKEN`, with the GitHub path to the
  Secrets tab and why not a Variable or an environment secret: `components/secret-steps.tsx`). The
  project settings page groups its sections under the two options, the screen after creating a
  project (`TokenReveal`) and `/github/installed` (`SetupOptions`, signed in or out) show both.
  Short copy, no wizard. A token value appears only in `TokenReveal`'s box, once
  (`test/setup-copy.test.ts`).
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

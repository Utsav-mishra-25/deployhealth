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
    src/lib/          ingest handler, validation (zod), guard (read-only demo), demo owner, paths,
                      handoff loader, share-link signing, rate limiter, auth providers (+ the OAuth
                      scopes and what sign-in reads), formatting, github-webhook.ts (signature,
                      dedupe, per-installation limit, events), jobs.ts (send-only pg-boss client),
                      read-body.ts (capped streaming body reader), legal.ts (operator, hosting,
                      subprocessors, retention wording), titles.ts (page titles), landing.ts, brand.ts,
                      worker-health.ts (the deep health check's response), github-app.ts (project
                      prefill and safe return paths for the App's next steps), security.ts
                      (security.txt and the security contact), app-url.ts (the public base URL from
                      the request's headers), db.ts (the shared database handle), project-status.ts
                      (one status per project, its reasons, ordering, the summary line),
                      deploy-changes.ts (a deploy's "what changed" and outage lines, commit links)
    src/views/        page bodies shared by signed-in and /demo routes: clients overview, client,
                      project, handoff, report (props: ownerId/data, paths, readOnly)
    src/app/          / (landing when signed out, else → /clients), /login, /clients, /clients/new,
                      /clients/[slug](/edit, /report), /projects/new, /projects/[id] (+ endpoint
                      actions, /settings, /handoff, /handoff.md), /demo/... (read-only mirror),
                      /share/reports/[token], /api/demo/broken, /security, /privacy, /terms and
                      /.well-known/security.txt (public), /api/health (Railway's, no database),
                      /api/health/worker (deep check), /api/github/webhook (GitHub App),
                      /github/installed (the App's setup URL); icon.svg, opengraph-image.tsx (+
                      twitter-image), sitemap.ts
    src/components/   badges, breadcrumb, endpoints section, latency chart (Recharts, client-only),
                      SafeMarkdown, demo banner, print/share buttons, report toolbar, alert card,
                      landing, prose-page (layout of /security, /privacy, /terms)
    e2e/              Playwright: public demo (+ handoff, report) and the signed-in flow (+ share link);
                      mobile.spec.ts (375 px), a11y.spec.ts (axe)
    railway.json      documentation only: the Railway build/deploy fields set by hand in the dashboard
```

And in core, for client components:

```
    src/browser.ts    `@deployhealth/core/browser`: the pure subset for client components
```

## Conventions

- **Public pages** (`/`, `/login`, `/demo/...`, `/share/*`, `/security`, `/privacy`, `/terms`, `/docs/...`,
  and `/github/installed` signed out): no
  external assets (fonts, scripts, images, analytics), server components unless interactivity is
  unavoidable, and no sideways scroll at 375 px (`e2e/mobile.spec.ts`; wide tables go inside their
  own `overflow-x-auto` box, or `.doc-scroll` on printable pages, which prints full width; long
  names and paths get `break-all`/`break-words`). No new env vars for them without a decision.
- **Accessibility:** every public page, the signed-in /clients, a client page, a project page with
  a deploy, its settings page and a shared report have no serious or critical axe violations (WCAG 2.1 A/AA tags; `e2e/a11y.spec.ts`; add new
  public pages there). Small text and buttons with white text use emerald-700, never emerald-600
  (3.65:1 on white); muted text on white or gray-50 is gray-500, never gray-400. The icon and the
  OG image keep `BRAND_GREEN` (emerald-600): a graphic and large text need only 3:1.
- **`/`** is the landing page for signed-out visitors (indexable) and redirects signed-in users to
  /clients. Its example alert is built by `alertOpenedMessage()` with the demo incident's values
  (`lib/landing.ts`, tested against the seed); the demo button shows only with `DEMO_PUBLIC=1`, and
  "Sign in with GitHub" links to /login (no inline server action, so the guard test's list holds).
  "Free while in beta", never prices. The bundle size it states is `CLI_BUNDLE_KB` (core), pinned to
  the built CLI by `test/npm-package.test.ts`. Under the unchanged headline, the supporting line is
  `LANDING_SUPPORTING_LINE` ("Like Dependabot, but for your .env.example: …"; a comparison only, no
  logos or marks, nothing implying an affiliation), then `LANGUAGES_SENTENCE`; it links /docs.
- **Docs pages** (`/docs`, `/docs/nextjs`, `/docs/laravel`, `/docs/spring-boot`; the slugs are
  `DOCS_STACK_SLUGS` in core, shared with the worker's PR comment footer): static server components
  rendered from `lib/docs-pages.ts`, no session or user data, indexed, canonical URLs, titles under
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
- **Metadata:** the root layout sets `metadataBase` from `appUrl()` and generic Open Graph / Twitter
  (`summary_large_image`) cards titled "deployhealth" on every page, so link previews never carry a
  client's name. `app/opengraph-image.tsx` (next/og, its bundled font, rendered at build) is the
  preview. Page titles come from `lib/titles.ts`: "<project> · deployhealth", "Handoff · <project>
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

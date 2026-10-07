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
                      the request's headers), db.ts (the shared database handle)
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

- **Public pages** (`/`, `/login`, `/demo/...`, `/share/*`, `/security`, `/privacy`, `/terms`, and
  `/github/installed` signed out): no
  external assets (fonts, scripts, images, analytics), server components unless interactivity is
  unavoidable, and no sideways scroll at 375 px (`e2e/mobile.spec.ts`; wide tables go inside their
  own `overflow-x-auto` box, or `.doc-scroll` on printable pages, which prints full width; long
  names and paths get `break-all`/`break-words`). No new env vars for them without a decision.
- **Accessibility:** every public page, the signed-in project settings page and a shared report
  have no serious or critical axe violations (WCAG 2.1 A/AA tags; `e2e/a11y.spec.ts`; add new
  public pages there). Small text and buttons with white text use emerald-700, never emerald-600
  (3.65:1 on white); muted text on white or gray-50 is gray-500, never gray-400. The icon and the
  OG image keep `BRAND_GREEN` (emerald-600): a graphic and large text need only 3:1.
- **`/`** is the landing page for signed-out visitors (indexable) and redirects signed-in users to
  /clients. Its example alert is built by `alertOpenedMessage()` with the demo incident's values
  (`lib/landing.ts`, tested against the seed); the demo button shows only with `DEMO_PUBLIC=1`, and
  "Sign in with GitHub" links to /login (no inline server action, so the guard test's list holds).
  "Free while in beta", never prices. The bundle size it states is `CLI_BUNDLE_KB` (core), pinned to
  the built CLI by `test/npm-package.test.ts`.
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

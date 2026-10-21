# CLAUDE.md

deployhealth is one page for every client project a freelancer maintains: is the config sane (env
var drift between code and env files), is it up (uptime checks), and did the last deploy break it
(alerts linked to the deploy that introduced new missing variables).

Built: Phases 1–6, from config health to "can't check" on unsupported stacks, PHP/Laravel and
Java/Kotlin with Spring (CLI 0.5.0), docs pages, the Action and a security pass, plus Phase 7 part 1
(landing page, header nav, /pricing, 404, demo guide) and part 2 (a project page in section order
with what to do per finding, a monthly report written for clients), Phase 8.1 (first-run onboarding: setup
checklist, App coverage, no token at creation) and Phase 9 part 1 (redacted logs, Sentry, operator
alerts, /account export and deletion, status link, runbooks) and part 2 (daily backups to R2 from a
separate backup service, restore that re-applies deletions) and Phase 10 (alert trust: recovery after
2 ok checks, pausing resolves, HEAD → GET on 405, honest intervals, alert history read model)
and Phase 10.1 (launch hardening: alerts name env vars a deploy added, heartbeat after each claim,
25 checks at a time, a claim that never waits on the demo reseed, honest no-data report summary)
(list: development.md).

This file is the table of contents. The detail lives in `docs/architecture/`: read the file for
an area before changing it (index at the end). Each app and package has a short CLAUDE.md naming
its docs, and `AGENTS.md` points other coding agents here.

## Layout

- `apps/web`: Next.js 15 app: UI, Auth.js, ingest API, GitHub webhook, public pages.
- `apps/worker`: Node process on pg-boss: uptime checks, alerts, prune, demo reseed, PR checks; plus
  the backup service (`dist/backup.js`, `apps/worker/backup.Dockerfile` and Railway cron) and `dist/restore.js`.
- `packages/core`: scanner, CLI, SSRF guard, alert, handoff and report rules (MIT).
- `packages/db`: Drizzle schema, migrations, queries, seed.
- `docs`: the Railway deploy guide, the incident and maintenance runbooks, the GitHub App manifest,
  `architecture/`.
- `scripts`: `eval-repos.mjs` (scanner accuracy), `load-demo.mjs` (load check) and
  `laravel-framework-names.mjs` (core's Laravel list), all manual.

## Commands

```sh
pnpm install         # then `docker compose up -d` (Postgres) and the env files: development.md
pnpm dev             # web on http://localhost:3000 + worker
pnpm test            # all unit tests: core, db (real Postgres), web, worker (all Vitest)
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e             # Playwright on a production build (next build + next start; also in CI)
pnpm scan:self       # run deployhealth's own scanner on this repo; must report nothing
pnpm eval:repos      # manual: counts per repo on pinned public repos
pnpm laravel:names   # manual: check core's Laravel framework names against pinned tags
pnpm load:demo       # manual: p50/p95/errors/rps of the public pages on `next start`
```

One file: `pnpm --filter @deployhealth/core exec vitest run test/scan.test.ts`.

## Working conventions

- **Plan first.** Before writing code for a phase or a larger change, show the file structure
  (and any schema changes) and wait for a go-ahead.
- **Small conventional commits**, one per logical unit, made as you go: `feat:`, `fix:`, `test:`,
  `docs:`, `chore:`, `ci:` (optionally scoped, e.g. `feat(web):`).
- **No attribution trailers** in commit messages (no `Co-Authored-By:`, no `Claude-Session:`).
- **No "Generated with Claude Code" footer or session links** in PR descriptions or commit messages.
- **Commits are authored by the maintainer:** set git `user.name`/`user.email` to
  `Utsav Mishra <utsav.mishra25@gmail.com>` at the start of a session; no attribution trailers.
- **Push only when asked.** The maintainer reviews; pushes happen at the end of a phase, after the
  full suite is green, when the maintainer says so.
- **Test as you go.** Run the relevant test file after each change; run the full suite
  (`pnpm typecheck && pnpm lint && pnpm test && pnpm build`, plus `pnpm e2e`) at the end of each phase.
- **End each phase with a short summary:** what's done, what's stubbed, and which decisions need review.

## Rules that must never break

- **Env vars** are read only in each app's `env.ts`, by name, and listed in its `.env.example`.
  → development.md
- **Every query the web app calls is owner-scoped** (it takes the signed-in user's id; the one
  exception is `getClientReport`, for share links); extend `test/isolation.test.ts` with each new
  one. Worker-only queries take ids the worker already holds and are listed in worker.md.
  → security.md, worker.md
- **Every server action calls `requireWritableUser()` first.** → demo-and-seed.md
- **All outbound HTTP goes through `apps/worker/src/guarded-http.ts`**, and saved URLs pass
  `assertPublicUrl()`; `no-unguarded-http.test.ts` enforces it. → security.md
- **Never values:** env values are never sent, stored, printed or logged; names, paths and line
  numbers only. → scanner.md, github-app.md
- **Logs and error reports** pass through `@deployhealth/db/redact` (both servers install the
  redacting console at startup; Sentry's `beforeSend` is `scrubErrorEvent`); never hand a raw
  error object to `console`. → security.md
- **Account deletion** goes through `deleteUser()` (self-serve and the operator's CLI alike), which
  records it in `account_deletions`; a new user-owned table joins its lists and the export.
  → database.md
- **Backups** keep `BACKUP_RETENTION_WEEKS` dumps (`packages/db/src/retention.ts`, the one number)
  and prune only after a successful upload; a restore goes only into an empty database and
  re-applies account deletions; the R2 keys live on the backup service alone. → worker.md
- **Tokens:** only the SHA-256 is stored; the plaintext is shown once. → ingest-and-cli.md
- **Untrusted Markdown** renders only through `SafeMarkdown`; never add rehype-raw. → web.md
- **Public pages:** no external assets, server components, no sideways scroll at 375 px, no new
  env vars without a decision. → web.md
- **Hard caps** live in `packages/core/src/limits.ts` and hold for every account. → security.md
- **Schema changes** go through `pnpm db:generate`; never edit an applied migration.
  → database.md
- **Licensing:** `packages/core` is MIT, everything else FSL-1.1-MIT; moving code into core
  relicenses it. → development.md
- **Client components** import only from `@deployhealth/core/browser`. → web.md
- **The dev login** exists only with `AUTH_DEMO_LOGIN=1` outside production, gated in one
  function. → web.md
- **Every parser of untrusted input** runs in linear time and has a timing test. → scanner.md
- **The PR check runs isolated** in a worker thread with a time limit; a failure there is
  "Couldn't be checked", never retried. → github-app.md
- **/security and /privacy stay true to the code**, built from shared constants. → security.md

## Before changing an area, read

| Area | Read |
| --- | --- |
| Local setup, tests, CI, scripts, licensing, env vars | `docs/architecture/development.md` |
| `apps/web`: pages, auth, public pages, metadata, health checks | `docs/architecture/web.md` |
| `apps/worker`: jobs, queues, check-endpoints, prune, reseed | `docs/architecture/worker.md` |
| The GitHub App: webhook, pr-check, isolation, PR output | `docs/architecture/github-app.md` |
| The scanner, env parser, gitignore, fixtures | `docs/architecture/scanner.md` |
| The CLI, ingest, tokens, releasing to npm | `docs/architecture/ingest-and-cli.md` |
| `packages/db`: schema, migrations, queries | `docs/architecture/database.md` |
| The public demo, the read-only guard, the seed | `docs/architecture/demo-and-seed.md` |
| Alerts, webhooks, endpoint names, monthly reports | `docs/architecture/alerts-and-reports.md` |
| Caps, SSRF, authorization, share links, headers, /security, /privacy | `docs/architecture/security.md` |

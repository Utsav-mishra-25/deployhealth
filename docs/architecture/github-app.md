# GitHub App: pull request checks

The App's webhook (web), the `pr-check` job (worker), its isolation and its output on GitHub. Read
before changing `apps/web/src/lib/github-webhook.ts`, `apps/worker/src/github/` or
`apps/worker/src/pr-check/`.

## Layout (worker)

```
    src/github/       app.ts (App JWT → installation token via @octokit/auth-app, one client per
                      installation), api.ts (the few GitHub calls a check makes)
    src/pr-check/     build.ts (GitHub calls and the caps, on the main thread), isolate.ts (the worker
                      thread + time limit; UncheckableError), isolate-worker.ts (its entry, bundled
                      as dist/pr-check-isolate.js), analysis.ts (select files, scan, diff, secrets:
                      what runs in the thread), diff.ts, secrets.ts, agents.ts, report.ts
                      (conclusion, the comment, the check run, GitHub's size limits),
                      coverage.ts (what a check reads, from the tree listings alone)
```

## The PR check runs isolated with a time limit

- **The PR check runs isolated with a time limit.** Its CPU work (file selection, scanning, diff,
  secret search; `pr-check/analysis.ts`) runs only in the worker thread from
  `openPrCheckIsolate()`, never on the main event loop, and gets only downloaded data. The entry
  file is fixed (`isolateEntry()`): no env var or config can point it elsewhere. Anything failing
  in the thread (time limit, a thrown error, out of memory) is `UncheckableError`: a neutral
  "Couldn't be checked" check run with a fixed message, no comment, and no retry. GitHub and
  database errors throw and retry. The thread hands back at most 1,000 rows per list and 10,000
  undeclared names, with exact totals in `counts`, so copying, storing and rendering a result
  stays cheap. `test/isolate.test.ts` checks the event loop and check-endpoints stay on time while
  a check runs out its limit, and that a huge result doesn't stall the loop either.

## Every check says what it read

`coverage.ts#treeCoverage` runs in the isolate with the file selection (task `select`) and works
only from the two tree listings (path, blob sha, size): the supported source files read in head per
language (`SUPPORTED_LANGUAGES`, core `languages.ts`), all files read (source, env and declaration
files, Compose files), how many of them the pull request changes (added, deleted, or a different
sha between merge base and head), and the source files it doesn't read (`UNREAD_SOURCE_EXTENSIONS`,
counts by extension only, never paths; same skip, vendored and test rules). Each pass is linear,
with Maps; `test/coverage.test.ts` holds a 6 s bound on 100k entries a side (about 0.8 s on a
laptop; a quadratic version ran past 98 s). `build.ts` decides the outcome from it **before any
blob is downloaded**. The outcomes, in order:

1. Mode `off` → nothing at all.
2. A tree GitHub truncated → neutral "too large to check".
3. The isolate fails during selection → neutral "Couldn't be checked", no comment, no retry.
4. **Can't check:** head holds no supported source file (env and declaration files don't count;
   tests and vendored code don't either) → no blob downloads; only the checks that don't depend on
   a language run: secrets on the pull request's added lines, and committed env files from the
   tree paths. Nothing flagged → neutral in every mode, strict included, titled
   `deployhealth can't check this repo yet: no JS/TS, Python, Go or Ruby files found`, with a
   summary naming the languages read and the unread ones found by extension, and a README link;
   no comment is created (an earlier comment on the pull request is rewritten to say so, since its
   findings no longer describe the head). Something flagged → today's conclusion and comment
   (strict fails), titled e.g. `Committed env file found; deployhealth can't check env vars in this
   repo yet (no JS/TS, Python, Go or Ruby files)`.
5. The fetch caps (2,000 files / 20 MB) → neutral "too large to check".
6. The isolate fails during the analysis → "Couldn't be checked", as 3.
7. **Nothing changed that it reads:** the pull request changes no read file → no blob downloads,
   the secret search still runs; nothing flagged → success, titled
   `No JS/TS, Python, Go or Ruby files or env files changed`, the summary counting unread source
   files the pull request changed (e.g. "This pull request also changed 3 .java files, which
   deployhealth doesn't read yet."); no comment is created (an earlier one is updated, as for any
   clean head).
8. **Checked:** as before. A clean pass is titled with both counts, e.g. `Checked 42 files (JS/TS,
   Python), 3 changed: no undeclared env vars` (the language list is shortened to `JS/TS +3`
   past 255 characters, never the counts), and its summary gives the count per language.

`PrReport.outcome` and `coverage` carry this to `report.ts` (`titleFor`, `coverageLines`); the
worker's log line names the outcome when it isn't `checked`. On `/projects/[id]`, a neutral run
that flagged nothing reads "Not checked" (`prResult` in `components/pr-checks.tsx`).

## How it works

Registered from `docs/github-app-manifest.json` (checks: write, contents: read, metadata: read,
pull_requests: write; events: pull_request; installation events arrive regardless). Web needs
`GITHUB_APP_WEBHOOK_SECRET` and `GITHUB_APP_SLUG`; the worker `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY` (base64 PEM). Unset, the webhook 404s and the worker doesn't work the queue.

- **Webhook** (`lib/github-webhook.ts`, unit-tested with injected deps): read the body (5 MB cap,
  counted while streaming) → verify `X-Hub-Signature-256` (HMAC-SHA256, `timingSafeEqual`) → parse →
  rate-limit per installation id (120/min, in memory, 429 + Retry-After) → dedupe by
  `X-GitHub-Delivery` (`webhook_deliveries`, pruned after 24 h; forgotten again if handling fails,
  so a redelivery runs) → dispatch. Installation events are handled inline; `pull_request`
  opened / synchronize / reopened / base-changed queue a `pr-check` job; closed / reopened set
  `pr_checks.closed_at`. No GitHub API calls, 202 fast, and log lines never contain payload data.
- **Linking and mapping.** `installations.installer_github_id` is the delivery's sender; `user_id`
  is set to the user with that GitHub id when the installation arrives or at their next sign-in
  (`linkInstallationsForUser` in the Auth.js `jwt` callback). Never link from the setup URL's query
  string. `findPrCheckTarget` returns only the linked user's project for the repo (case-insensitive,
  oldest if several, installation not suspended); no match → nothing stored, one log line.
- **Next steps.** `listInstallationsForUser` gives each repo the user's own project (or null) and
  `reposWithoutProject` the repos of non-suspended installations with none. `/github/installed`
  (public: signed out it says to sign in and come back via `/login?next=`) and `/clients` show
  "Add a project for owner/repo to start pull request checks", linking to `/projects/new?repo=`,
  which pre-fills the form (`lib/github-app.ts`: `projectPrefill`; `safeReturnPath` admits only
  paths on this site, never another origin or a query string).
- **Queue.** `pr-check` is `stately` with singletonKey `installation:repo#pr`: one running, at most
  one waiting. The job data is only `{ installationId, repoFullName, prNumber }`; the job reads the
  pull request's current head and its **merge base** (compare API) when it runs.
- **Auth.** `createGithubApp()` keeps one Octokit per installation (`@octokit/auth-app` signs the
  App JWT and caches the installation token until shortly before expiry). Octokit's `request.fetch`
  is `githubFetch`, so every GitHub call is SSRF-guarded and pinned to api.github.com.
- **The check** (`jobs.ts#prCheck`, tested against a mocked Octokit in `test/pr-check-job.test.ts`):
  mode `off` → nothing at all. Otherwise `buildReport()`: both trees (recursive; truncated → not
  checked), `selectTreeFiles()` in the isolate (the CLI's rules except `.gitignore`: git never
  ignores a tracked file, so none is read or applied), each distinct path + blob reserved against
  `createFetchBudget()` (2,000 files / 20 MB, PR patches included) **before** downloading, each
  distinct blob downloaded once; then in the isolate `scanFiles()` on both sides; `diffEnvVars()` (variable level; rename =
  removed + added in the same file; declared = in the `.env.example` of every scope that reads it);
  committed env files the PR adds or changes; `findSecrets()` on added lines (rule + file:line only).
  A cap → neutral "too large to check"; the isolate failing → neutral "Couldn't be checked", no
  comment, no retry. Conclusion: success when nothing is undeclared and no env files or secrets;
  else neutral (comment) or failure (strict).
- **Idempotent output.** One `pr_checks` row per project + PR + head (upsert keeps comment and check
  run ids). One comment per PR: stored id → else the latest row's → else the comment with the
  `<!-- deployhealth-env-check -->` marker whose `performed_via_github_app.id` is this App's
  (`GITHUB_APP_ID`; never someone else's marked comment); created only when there's something to
  say, recreated if deleted (404). One `deployhealth / env` check run per head, updated on re-runs.
  The comment and the check run's summary and text stay under 60,000 characters (whole lines, then
  "…and N more"); titles ≤ 255; long paths and names are shortened around an ellipsis.
- **Agents:** PR author login (without `[bot]`) in the known list, else a `Co-Authored-By` trailer
  naming Claude, Codex, Copilot, Cursor or Devin. Dependabot and Renovate are never agents.
- **Never values.** Comments, check runs, rows and logs carry names, paths, line numbers and rule
  ids only. Test fixtures that look like secrets are assembled at run time (see the tests).

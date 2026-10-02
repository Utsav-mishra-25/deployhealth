PHASE 4.9 — Unsupported stacks say so (before Show HN)

Read CLAUDE.md first, then docs/architecture/github-app.md, web.md, scanner.md and
ingest-and-cli.md.
State of the repo: main is at 3b97df2 (Phases 1–4.8 and the CLAUDE.md slim-down are merged; CI
and the dogfood scan are green; deployhealth-scan@0.3.1 is on npm and pinned).
Work on a new branch claude/phase-4-9-unsupported-stacks from origin/main. Set git user.name and
user.email to Utsav Mishra <utsav.mishra25@gmail.com> before the first commit.
Show me the file structure and the numbered decisions, wait for my go-ahead, then build.
Conventions unchanged: small conventional commits, the relevant tests after each change, the full
suite on the tip at the end (typecheck, lint, test, build, e2e, scan:self), then a done / stubbed /
decisions summary. Don't run a per-commit check of every commit. No attribution trailers, no
"Generated with Claude Code" footer. Push only when I say so; then paste the PR title and
description as plain text in a code block, and I open the PR myself.
Scope guard: no schema change, no new env var, no change to the ingest payload shape. One CLI
release (0.3.2, Part 3), published by me. If something seems to need more, stop and say why
instead of doing it.

Why: Show HN is Tue 6 / Wed 7 Oct, and this phase merges by Sunday 4 Oct. The first outside
tester installed the App on a Java/Spring repo, opened a PR that added an env var through a
.properties file and System.getenv, and got a green check with no comment. The scanner reads
JS/TS, Python, Go and Ruby only, so that green meant "read nothing", not "fine". On HN someone
will do the same on a Rust or PHP repo, and far more readers will run `npx deployhealth-scan
--dry-run` on their own repo than will install the App. Every result, in the App and in the CLI,
must say what it read, and a repo it can't read must say that plainly.

PART 1 — The PR check says what it read (packages/core, apps/worker)

1. One list of supported languages.
   - A browser-safe constant in packages/core (also exported from @deployhealth/core/browser)
     naming each supported language and the extensions the scanner reads for it, plus the display
     string "JS/TS, Python, Go or Ruby" / "JS/TS, Python, Go and Ruby".
   - A test pins it to what scanner.ts actually reads, so the two can't drift.
   - A second short fixed list of common source extensions the scanner does NOT read (at least
     .java, .kt, .kts, .scala, .groovy, .properties, .php, .rs, .cs, .ex, .exs, .swift, .dart),
     used only for messages, never for scanning.
   - Everything below that names languages uses these constants (App, CLI, web, README test).

2. A repo with no supported source files gets a neutral "can't check".
   - Rule: after the usual selection rules (vendored, size, test paths), the head tree contains no
     source file in a supported language. Env and declaration files don't count: a Java repo with
     a .env.example still can't be checked.
   - Check run: neutral in every mode, strict included (never block a merge on a repo we can't
     read), titled exactly:
       deployhealth can't check this repo yet: no JS/TS, Python, Go or Ruby files found
   - Summary: the supported languages; that Java/Kotlin, PHP, Rust, C# and others aren't read yet;
     the counts of unsupported source files found by extension (counts only, no paths); a link to
     the README's language section.
   - No comment. Decision: say if you think one comment on the repo's first checked PR is better.
   - Decide it from the tree listing, before any blob is downloaded. Selection runs in the isolate
     today; keep the CPU work there and say where this decision is made.
   - The existing caps ("too large to check") and the isolate's "Couldn't be checked" keep their
     current precedence; state the order of the outcomes in a decision.

3. A PR that changes no file the check reads says so.
   - Rule: the repo has supported source files, but the PR (merge base → head) changes none of the
     files the check reads (supported source, env and declaration files).
   - Check run titled exactly:
       No JS/TS, Python, Go or Ruby files or env files changed
     Decision: success or neutral. My default is success, since nothing it can read is wrong.
   - Summary: the counts of unsupported source files the PR changed, by extension, if any (e.g.
     "This PR also changed 3 .java files, which deployhealth doesn't read yet").
   - The secret search on added lines still runs as today; if it flags something, today's
     conclusion and comment rules apply.

4. A clean pass says what it read, with both counts.
   - The success title states the files read in the head tree and how many of them the PR
     changed, e.g.:
       Checked 42 files (JS/TS, Python), 3 changed: no undeclared env vars
     Keep it under 255 characters (shorten the language list, never the counts).
   - The summary gives the count per supported language, and the unsupported source files the PR
     changed (counts by extension), within the existing 60,000-character limit.

5. Unchanged: mode off, comment idempotency, the comment's content when something is flagged, the
   retries for GitHub and database errors. If a PR's earlier head got a comment and a later head
   falls under rule 2 or 3, tell me what happens to that comment today and keep it unless it's now
   wrong.

PART 2 — Name the languages up front, and split setup into two options (apps/web, packages/db,
docs)

6. README.
   - The opening (the first screen, before the first screenshot) names the languages in one line.
   - "Known limitations" gets a first bullet, "Languages": what's read, what isn't yet, and that
     both the pull request check and the CLI say "can't check" on such a repo instead of passing.
   - The "Pull request checks" section lists the three outcomes (findings, nothing changed that it
     reads, can't check this repo).
   - A test asserts the README's language line matches the constant (like CLI_BUNDLE_KB).
7. Landing page /: one line naming the languages near the hero or the how-it-works block, from the
   constant. Public-page rules hold: server component, no external assets, no sideways scroll at
   375 px.
8. Setup, split into two options wherever a user sets up: the project's "Settings & GitHub Action"
   page, the screen after /projects/new, /github/installed, and the README's setup steps.
   - Pull request checks: install the GitHub App and add a project for the exact owner/repo. No
     token, no secret, no variable.
   - Deploy history and alerts: the GitHub Action, plus the ingest token as a repository secret
     named DEPLOYHEALTH_TOKEN (repo Settings → Secrets and variables → Actions → Secrets tab → New
     repository secret). Not a Variable (the Variables tab shows values in plain text to anyone
     with access) and not an environment secret (the snippet declares no environment).
   - Short copy, not a wizard. Never show or log a token value anywhere new.
9. Project page: if the latest scan has no referenced variables and no env scopes, show one
   notice: "The last scan found no env var references. deployhealth reads JS/TS, Python, Go and
   Ruby." From existing data only; owner-scoped as always; no schema change.
10. The demo seed's sample pull request checks (#86–#88) must stay consistent with the new titles
    and summaries; keep the seed tests and the e2e demo flow green.
11. Docs: github-app.md (the outcomes, their titles and their order), web.md (the landing line,
    the setup copy), scanner.md (the constants), ingest-and-cli.md (the CLI's new line and the
    0.3.2 release). Add this prompt verbatim as docs/prompts/phase-4-9-unsupported-stacks.md and
    list it in docs/prompts/README.md.

PART 3 — CLI 0.3.2 says so too (packages/core)

12. When the scan finds no supported source file after the usual selection rules, the CLI prints
    one plain line:
      No JS/TS, Python, Go or Ruby source files found: deployhealth can't check this directory yet.
    - It exits 0 (never break anyone's CI), in text and --json output alike. Propose the --json
      field as a decision.
    - The ingest payload shape doesn't change. Decision: whether such a scan is still sent. My
      default is yes, so the deploy is recorded, and the project page notice in item 9 explains
      it.
    - Bump CLI_VERSION, npm/package.json and the npm README (with the same language line as the
      README) to 0.3.2. PUBLISHED_CLI_VERSION and every pin stay 0.3.1 in this PR.
    - Paste the before/after --dry-run output on a temp directory holding only a few .java and
      .properties files.

Tests (apps/worker/test/pr-check-job.test.ts, the analysis tests with mocked Octokit, the CLI and
seed tests):
- a tree of only .java, .kt, .properties and pom.xml → neutral, the can't-check title, no comment,
  no blob downloads; the same in strict mode → still neutral;
- the same tree plus a .env.example → still can't check;
- a tree whose only JS is vendored or test files (e.g. *.test.ts, a vendored dir) → can't check;
- a JS repo, PR changes only README.md → rule 3 title, no comment;
- a JS repo, PR changes only a .java file → rule 3 title, summary counts the .java file;
- a normal clean PR → the "Checked N files (…), M changed" title with per-language counts, and a
  title that stays under 255 characters with every language present;
- a PR that adds an undeclared var → today's comment and conclusion, unchanged (regression);
- a PR that adds a secret-shaped string in a .java file in a JS repo → still flagged as today;
- the constant matches what scanner.ts reads;
- the CLI on a Java-only directory: the line, exit 0, text and --json; on a JS directory: output
  unchanged apart from anything you decide to add;
- the demo seed's PR checks match the new wording.
- Timing: anything new that walks trees or counts extensions on hostile input stays linear, with
  bounds that have ~4x headroom over GitHub's runners and are shown to fail on a quadratic
  version.

Stop after the plan. After the build, stop with the summary, the PR title and description, and the
human steps I still owe:
- I merge and Railway deploys; then the live checks: a throwaway repo with only Java files, App
  installed, project added, a PR → the neutral can't-check run, no comment; a README-only PR on
  deployhealth itself → the rule 3 title; deployhealth.dev at 375 px: the landing line and the
  setup copy on a project's settings page.
- I publish 0.3.2 from my machine (pnpm --filter @deployhealth/core build:npm, then in
  packages/core/npm: npm whoami && npm publish) and check npm view deployhealth-scan versions.
- Then you bump PUBLISHED_CLI_VERSION and every pin (snippet, dogfood workflow, README) to 0.3.2
  in a separate small PR: push the branch, paste the PR text, I open it.

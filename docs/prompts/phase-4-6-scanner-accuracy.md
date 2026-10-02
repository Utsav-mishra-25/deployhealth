PHASE 4.6 — Scanner accuracy on real repos (CLI 0.3.0, before Show HN)

Read CLAUDE.md first. State of the repo: main is at 687aff2 (Phase 4.5 Parts 1–2 and the 0.2.0
pins are merged); deployhealth-scan@0.2.0 is on npm as latest. Work on a new branch
claude/phase-4-6-scanner-accuracy from origin/main.
Show me the file structure and the numbered decisions, wait for my go-ahead, then build.
Conventions unchanged: small conventional commits, relevant tests after each change, full suite
at the end, then a done / stubbed / decisions summary. Push only when I say so. Don't run a
per-commit check of every commit; the full suite on the tip is enough.

Why: Show HN is Tue 6 / Wed 7 Oct and the first thing commenters will do is
`npx deployhealth-scan --dry-run` on their own repo. I ran 0.2.0 on five public repos:
vercel/commerce, shadcn-ui/taxonomy and t3-oss/create-t3-app are clean, but
fastapi/full-stack-fastapi-template reports 11 UNUSED (all false) and calcom/cal.com reports 123
MISSING, roughly 70% noise:
- ~30 come from .yarn/releases/yarn-4.12.0.cjs (a vendored bundle);
- ~30 are declared in .env.appStore.example, which the scanner doesn't read;
- ~28 sit in test-like files the patterns miss (*.e2e.ts, a playwright/ dir, packages/testing/,
  vitest.config.mts);
- the text output repeats a row when one line reads the same variable twice.
The FastAPI template's UNUSED come from pydantic-settings (`class Settings(BaseSettings)` reads
env vars through field names) and from docker-compose `${VAR}` interpolation.

PART 1 — Fix the noise (packages/core; the App's PR check picks it up through core)

1. Vendored and generated code is never scanned.
   - Add to the default skipped directories: .yarn, vendor, third_party, bower_components,
     build, out, coverage, .turbo, .vercel, .output, .svelte-kit, .nuxt, .cache, .pnpm-store,
     __pycache__, site-packages.
   - Skip .pnp.cjs, .pnp.loader.mjs and *.min.js / *.min.mjs / *.min.cjs.
   - Skip any source file larger than 512 KB, with a dry-run line saying how many were skipped
     for size (bundles, not code people wrote).
   - Same rules in the App's tree selection.

2. More env file names declare variables.
   - Treat these as declaration files, like .env.example: .env.sample, .env.template,
     .env.dist, .env.defaults, and any .env.<name>.example / .env.<name>.sample /
     .env.<name>.template (e.g. .env.appStore.example), plus example.env, sample.env and
     env.example.
   - They define variables and can be UNUSED. MISMATCH still compares only .env with
     .env.example.
   - Keep the ingest contract backward compatible: decide how `defined_in` carries these names
     (widen the allowed set, or a pattern) without letting arbitrary strings through, and say
     which as a decision. The server must deploy before the CLI is published, as with 0.2.0.

3. Test tooling counts as tests.
   - Add file patterns: *.e2e.*, *.cy.*, and playwright.config.*, vitest.config.*,
     vitest.workspace.*, jest.config.*, cypress.config.*.
   - Add directories: playwright, cypress, __mocks__, testing.
   - Propose the final list as a decision if any entry looks risky to you.

4. One row per variable per file:line in every output (text, JSON, payload, PR comment), even
   when a line reads the variable twice.

5. Python pydantic-settings.
   - In a .py file, a class whose bases include BaseSettings (from pydantic or
     pydantic_settings): each annotated field at the class body's indentation
     (`name: type` or `name: type = default`) is a reference to the env var NAME uppercased.
   - A literal `env_prefix` (in `model_config = SettingsConfigDict(env_prefix="APP_")` or an
     inner `class Config: env_prefix = "APP_"`) is prepended.
   - A field with a default is optional. Fields that are clearly not env-backed (ClassVar,
     names starting with an underscore, nested model types if you can tell) are skipped.
   - Keep it regex-based and same-line, like the rest of the scanner. Document what's missed.

6. docker-compose interpolation counts as a use, never as MISSING.
   - In docker-compose*.yml / docker-compose*.yaml / compose*.yml / compose*.yaml,
     `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?msg}` and `$VAR` mark VAR as used
     in that file's scope, so a .env entry Compose consumes isn't UNUSED.
   - They never produce MISSING rows (Compose often reads values from the shell or CI).

7. CLI version 0.3.0. Update CLI_BUNDLE_KB if the size changes. PUBLISHED_CLI_VERSION stays 0.2.0
   until I publish.

Evaluation (this is the acceptance test):
- Add a manual script (not run in CI), e.g. `pnpm eval:repos`, that shallow-clones these repos at
  pinned commit SHAs (resolve today's default-branch SHAs and pin them in the script), runs the
  local CLI build with --json, and prints a table of MISSING / UNUSED / MISMATCH / OPTIONAL /
  skipped-test / skipped-vendored counts per repo:
  vercel/commerce, shadcn-ui/taxonomy, t3-oss/create-t3-app, fastapi/full-stack-fastapi-template,
  calcom/cal.com. Add two more of your choice that use Python or Go or Ruby.
- Run it with 0.2.0 (npx) and with this branch, and put both tables in the summary.
- Targets: cal.com MISSING well under 50; the FastAPI template's false UNUSED gone; the clean repos
  stay clean; no new false MISSING anywhere. For every MISSING left in cal.com, check whether it is
  declared anywhere the scanner could reasonably read; report the categories, not a list.
- The PR is public: report counts per repo only. Do not list other projects' variable names in
  the PR description, commit messages or committed files.

Tests: fixtures for each rule above (vendored dirs and the size skip, each new env file name,
the new test patterns, a src file named like "testing-utils.ts" outside a testing/ dir is NOT
skipped, the duplicate-row case, pydantic-settings with and without env_prefix and defaults,
compose interpolation forms), an ingest test that 0.1.0 and 0.2.0 payloads still pass, and a
worker PR-check test that a vendored .yarn file is never fetched.

Docs: README (scanner rules, known misses), the npm README, CLAUDE.md.

Stop after Part 1 with the summary, both evaluation tables and the human steps. Release order as
last time: I merge and deploy the server, publish 0.3.0 with 2FA and paste back the version, then
you bump the pins in a separate small PR.

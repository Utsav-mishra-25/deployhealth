# Ingest and the CLI

The CLI (`deployhealth-scan`), its payload, the ingest endpoint that receives it, tokens, and how
a CLI release goes out. Read before changing `packages/core/src/cli.ts`, `ingest.ts`, the npm
package, `apps/web/src/lib/ingest-handler.ts` or the Action snippet.

## Layout

```
    src/ingest.ts     zod payload schema, token generate/hash/hint, GitHub Action snippet
    src/cli.ts        deployhealth-scan (bundled by tsup into one 40 KB file, `CLI_BUNDLE_KB`; served by web)
    src/version.ts    CLI_VERSION, printed by --version; equals npm/package.json's version
    npm/              the published npm package `deployhealth-scan`: manifest + README (committed);
                      `build:npm` adds dist/ and LICENSE (gitignored)
    scripts/pack-npm.mjs  assembles npm/ from dist/ and checks the bundle's --version
```

## Tokens

- **Tokens:** `dh_` + 32 random bytes. Only the SHA-256 is stored, plus a `dh_…abcd` hint. The
  plaintext is shown once, when the user creates or replaces it in the project's settings (a new
  project's token is never shown: pull request checks need none, so creating a project shows no token).

## Ingest

- **Ingest:** authenticate first, then read the body (5 MB cap), validate with the zod schema from
  `@deployhealth/core`, drop finding rows that fail `isStorableFinding()` (`var_name` must match
  the env parser's key pattern `ENV_KEY_PATTERN`, `env_file` must be null or an env file name; one
  log line with the count), and store through `recordScan()`, which computes counts server-side. A
  re-reported sha adds a scan to the existing deploy. Every field a CLI release adds is optional
  (`variables` in 0.1.0; `variables[].optional` and `env_scopes` in 0.2.0), so older payloads keep
  working and are stored as before (`scans.env_scopes` null, nothing optional); zod drops fields it
  doesn't know. Env file names (`defined_in`, `env_files`) must pass `isEnvFileName()` (the fixed
  names plus `.env.<name>.example|sample|template`, 0.3.0), at most 64 per array. Deploy the server
  before publishing a CLI that sends new values (an older server rejects 0.2.0's and 0.3.0's new
  env file names). `test/ingest-handler.test.ts` pins a 0.1.0 payload.

## A directory it can't check (0.3.2)

- When the scan reads no supported source file (after the skip, vendored and test rules), the CLI
  prints `NO_SOURCE_FILES_LINE` (core `languages.ts`): "No JS/TS, Python, Go, Ruby, PHP or Java/Kotlin source files
  found: deployhealth can't check this directory yet." In `--dry-run` text it follows the header;
  with `--json` it goes to stderr and the JSON gains `"source_files": <n>` and `"can_check":
  <bool>` (always present; `can_check` is `source_files > 0`); without `--dry-run` it is printed
  and the scan is **still sent**, so the deploy is recorded and the project page's no-references
  notice explains it. Always exit 0 for this (never break anyone's CI). The ingest payload is
  unchanged: such a scan simply has no UNUSED rows (scanner.md, decision 18).

## Releasing the CLI (`deployhealth-scan` on npm)

- The package is `packages/core/npm`, outside the pnpm workspace (MIT, no dependencies, one bin).
  `pnpm --filter @deployhealth/core build:npm` bundles the CLI and fills `npm/dist` and
  `npm/LICENSE`; `test/npm-package.test.ts` checks the manifest, the packed file list and the bin.
- Two versions: `CLI_VERSION` (`src/version.ts`, = `npm/package.json`, what the next publish ships)
  and `PUBLISHED_CLI_VERSION` (`src/constants.ts`, what the Action snippet, the settings page and
  this repo's `.github/workflows/deployhealth.yml` pin). Tests keep each group in sync, and the
  first never behind the second. 0.3.1 (the 4.8 parser and matcher fixes, `DEPLOYHEALTH_TOKEN` as
  `--token`'s default, a warning for plain-http `--url` to another machine) and 0.3.2 (the
  can't-check line, `source_files` / `can_check` in `--json`, no UNUSED without supported source)
  and 0.4.0 (PHP and Laravel, Symfony's `%env()%`, the Laravel path rules, and OPTIONAL as one
  line in the text output: `--show-optional` lists the rows, `--json` is unchanged; the ingest
  payload didn't change) and 0.5.0 (Java and Kotlin: `System.getenv`, `@Value`, Spring's config
  placeholders and relaxed binding, Maven's and Gradle's build output skipped, Gradle's
  `*.gradle.kts` scripts as build tooling; the ingest payload didn't change) are on npm; 0.5.0 is
  `CLI_VERSION`, `PUBLISHED_CLI_VERSION` and every pin.
- To release: (1) bump `npm/package.json`, `src/version.ts` and the npm README (its workflow block
  must equal `githubActionSnippet({ version: CLI_VERSION })`), push, then publish: `npm publish` in
  `packages/core/npm` from a machine (no provenance). That's how releases go out today; the manual
  **Publish CLI** workflow (`.github/workflows/publish-cli.yml`) would add provenance but isn't used
  yet (see "Switching to the workflow" below).
  (2) Only once it's on npm, bump `PUBLISHED_CLI_VERSION` and the dogfood workflow.
  (3) Then the Action, in its own repository
  ([Utsav-mishra-25/deployhealth-action](https://github.com/Utsav-mishra-25/deployhealth-action)):
  bump the pinned `deployhealth-scan@x.y.z` in its `action.yml` and README, merge, release a new
  tag (`v1.x.y`) and move `v1` to it. This repository's pin tests can't see that one, so this step
  is the guard; the docs pages (`lib/docs-pages.ts`) reference the Action by `@v1` only.

## Switching to the workflow (not done yet)

`publish-cli.yml` is ready but unused; publishing stays manual until the steps below are done.
Its shape (pinned by `packages/core/test/publish-workflow.test.ts`): manual dispatch from `main`
only; a `build` job (no `id-token` permission) installs, runs core's tests and `build:npm`, and
uploads `packages/core/npm/` as the `npm-package` artifact (kept one day); a `publish` job with no
checkout and no install downloads that artifact and runs `npm publish --provenance` behind the
`npm-publish` environment, and is the only job with `id-token: write`. Every action is pinned by
full commit SHA with its version in a comment, and the npm CLI by exact version (`npm@11.21.0`;
trusted publishing needs 11.5.1 or later). To bump an action, resolve the new tag's commit with
`git ls-remote --tags https://github.com/<owner>/<action>.git` (for an annotated tag, the `^{}`
line) and change the SHA and the comment together.

To switch (each step: check on GitHub/npm, since both UIs move):

1. **GitHub, the environment:** repository → Settings → Environments → New environment, named
   exactly `npm-publish`. Check on GitHub.
2. **GitHub, its protection rules:** in that environment, **Required reviewers** → add yourself
   (`Utsav-mishra-25`), with "Prevent self-review" off (you also start the run); **Deployment
   branches and tags** → "Selected branches and tags" → add `main`. No environment secrets:
   trusted publishing needs no token. Check on GitHub.
3. **npm, the trusted publisher:** npmjs.com → package `deployhealth-scan` → Settings → Trusted
   Publisher → GitHub Actions: user `Utsav-mishra-25`, repository `deployhealth`, workflow
   filename `publish-cli.yml`, environment `npm-publish`. Check on npm.
4. **npm, optional, after the first successful run:** in the same settings, Publishing access →
   require two-factor authentication and disallow tokens, so only the workflow (or you, with 2FA)
   can publish. Check on npm.
5. **Releasing with it:** once step (1) of "To release" is merged to `main`, Actions → Publish CLI
   → Run workflow on `main`, approve the `publish` job when GitHub asks, and check that the version
   on npm shows a provenance badge. Steps (2) and (3) of "To release" don't change.

## Published versions and the generated workflow

- Published versions are immutable. Snippets and docs pin an exact version (`npx --yes deployhealth-scan@x.y.z`).
  The settings page and the token reveal lead with the **deployhealth env check** Action
  (`…/deployhealth-action@v1`, a composite action that runs the same pinned `npx` line, token through
  `DEPLOYHEALTH_TOKEN` only; `actionWorkflow()` in `lib/docs-pages.ts` is `ACTION_WORKFLOW` exactly on
  https://deployhealth.dev, the Action's default `url`, and adds `url:` on any other instance), then
  keep the exact-pinned workflow under "From any other CI": an Action tag can move, an npm version
  can't. The README and the docs pages offer the Action too.
- The generated workflow: push events only (never `pull_request` from forks: it reads a secret),
  job-level `permissions: contents: read`, `persist-credentials: false`, and
  `package-manager-cache: false` on setup-node (v5 otherwise looks for pnpm/yarn and fails). Sha and
  branch come from `$GITHUB_SHA` / `$GITHUB_REF_NAME`, never `${{ }}` inside the script. The token
  stays in the step's `env` as `DEPLOYHEALTH_TOKEN` (the CLI's default since 0.3.1) and is never
  passed as `--token`, so it isn't in the process's arguments; `--url` is quoted.
- `/deployhealth-scan.mjs` is still served (deprecated, `Deprecation` + `Link` headers from
  `next.config.ts`) for older workflows. Removal is a later phase.

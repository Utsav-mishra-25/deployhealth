# Ingest and the CLI

The CLI (`deployhealth-scan`), its payload, the ingest endpoint that receives it, tokens, and how
a CLI release goes out. Read before changing `packages/core/src/cli.ts`, `ingest.ts`, the npm
package, `apps/web/src/lib/ingest-handler.ts` or the Action snippet.

## Layout

```
    src/ingest.ts     zod payload schema, token generate/hash/hint, GitHub Action snippet
    src/cli.ts        deployhealth-scan (bundled by tsup into one 28 KB file, served by web)
    src/version.ts    CLI_VERSION, printed by --version; equals npm/package.json's version
    npm/              the published npm package `deployhealth-scan`: manifest + README (committed);
                      `build:npm` adds dist/ and LICENSE (gitignored)
    scripts/pack-npm.mjs  assembles npm/ from dist/ and checks the bundle's --version
```

## Tokens

- **Tokens:** `dh_` + 32 random bytes. Only the SHA-256 is stored, plus a `dh_…abcd` hint. The
  plaintext is shown once, on creation or regeneration.

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

## Releasing the CLI (`deployhealth-scan` on npm)

- The package is `packages/core/npm`, outside the pnpm workspace (MIT, no dependencies, one bin).
  `pnpm --filter @deployhealth/core build:npm` bundles the CLI and fills `npm/dist` and
  `npm/LICENSE`; `test/npm-package.test.ts` checks the manifest, the packed file list and the bin.
- Two versions: `CLI_VERSION` (`src/version.ts`, = `npm/package.json`, what the next publish ships)
  and `PUBLISHED_CLI_VERSION` (`src/constants.ts`, what the Action snippet, the settings page and
  this repo's `.github/workflows/deployhealth.yml` pin). Tests keep each group in sync, and the
  first never behind the second. 0.3.1 (the 4.8 parser and matcher fixes, `DEPLOYHEALTH_TOKEN` as
  `--token`'s default, a warning for plain-http `--url` to another machine) is on npm.
- To release: (1) bump `npm/package.json`, `src/version.ts` and the npm README (its workflow block
  must equal `githubActionSnippet({ version: CLI_VERSION })`), push, then publish: `npm publish` in
  `packages/core/npm` from a machine (no provenance), or the manual **Publish CLI** workflow
  (`.github/workflows/publish-cli.yml`), which adds provenance once npm trusted publishing is set up.
  (2) Only once it's on npm, bump `PUBLISHED_CLI_VERSION` and the dogfood workflow.
- Published versions are immutable. Snippets and docs pin an exact version (`npx --yes deployhealth-scan@x.y.z`).
- The generated workflow: push events only (never `pull_request` from forks: it reads a secret),
  job-level `permissions: contents: read`, `persist-credentials: false`, and
  `package-manager-cache: false` on setup-node (v5 otherwise looks for pnpm/yarn and fails). Sha and
  branch come from `$GITHUB_SHA` / `$GITHUB_REF_NAME`, never `${{ }}` inside the script.
- `/deployhealth-scan.mjs` is still served (deprecated, `Deprecation` + `Link` headers from
  `next.config.ts`) for older workflows. Removal is a later phase.

# Scanner (`packages/core`)

What the scanner reads and reports, the rules that keep a first scan quiet and accurate, the env
parser, the fixtures, and the timing rule for every parser of untrusted input. Read before
changing anything the CLI and the GitHub App use to scan (`scan.ts`, `scanner.ts`, `pydantic.ts`,
`compose.ts`, `symfony.ts`, `laravel.ts`, `build-dirs.ts`, `env-files.ts`, `env-parser.ts`,
`gitignore.ts`, `test-paths.ts`, `vendored.ts`, `findings.ts`, `default-ignore.ts`) or the fixtures.

## Layout

```
  core/               scanner + shared contract, no framework deps
    src/scan.ts       scanProject(): walks the repo, env scopes (+ envScopes, defaultIgnored), findings rows
    src/languages.ts  SUPPORTED_LANGUAGES (id, label, extensions), the display strings, the unread
                      extensions for messages, NO_SOURCE_FILES_LINE, LANGUAGES_SENTENCE (browser-safe)
    src/scanner.ts    per-language regexes (JS/TS incl. .mjs/.cjs/.mts/.cts, Python, Go, Ruby, PHP),
                      same-line inline defaults (Reference.hasDefault), one reference per name per line;
                      USED_ONLY reads (PHP's $_SERVER) that only mark a name used
    src/pydantic.ts   pydantic-settings fields as references (Python logical lines, env_prefix, aliases)
    src/compose.ts    Docker Compose files and the names they interpolate (used, never MISSING)
    src/symfony.ts    Symfony's %env(…)% in config/**/*.yaml|yml (references; not source files)
    src/laravel.ts    LARAVEL_MARKER (`artisan`), LARAVEL_FRAMEWORK_NAMES (generated: `pnpm laravel:names`)
    src/build-dirs.ts build output known by context: bootstrap/cache, public/build, storage/ beside
                      artisan; treeMarkers() / inContextualSkipDir() for tree listings (linear)
    src/env-files.ts  which file names are env files / declaration files; display order (browser-safe)
    src/vendored.ts   VENDORED_DIRS, generated file names, MAX_SOURCE_FILE_BYTES (512 KB)
    src/findings.ts   analyzeScope() / summarize(): MISSING, UNUSED, MISMATCH; newMissingVars() /
                      newUndeclaredVars() for deploy correlation
    src/default-ignore.ts  DEFAULT_IGNORE: names the platform or runtime provides, skipped by default
    src/gitignore.ts  .gitignore matching for the CLI's walk: each pattern a small state machine, linear time
```

## Every parser of untrusted input gets a timing test

- **Every parser of untrusted input gets a timing test.** Repository files (via the App or a
  cloned repo), .gitignore patterns, env files, payloads: each parser runs in time linear in its
  input (no regex built from input, no nested loops over names × files, no recursion on input
  depth, no `push(...array)` of unbounded arrays) and has a test that a hostile input, built at
  run time, finishes under a stated bound (`packages/core/test/hostile-inputs.test.ts`,
  `apps/worker/test/hostile-inputs.test.ts`, `gitignore.test.ts`, `env-parser.test.ts`).

## Rules

- **The quieter first scan** (core, so the CLI and the GitHub App's PR checks share it):
  `DEFAULT_IGNORE` (exact GitHub Actions names, never a `GITHUB_*` prefix: apps own GITHUB_ names;
  `--no-default-ignore` / `defaultIgnore: false`); a reference with a same-line default (JS `??`/`||`,
  Python a second argument or `or`, Ruby `ENV.fetch` default/block and `ENV[..] ||`; not
  `undefined`/`null`/`None`/`nil`) is never MISSING, and a variable read only that way is
  `optional`; a scope with no env file gets no MISSING rows, only its `EnvScope`, which the project
  page turns into one notice and the handoff into a starting `.env.example`. PR checks count an
  optional variable as declared. **Tests and fixtures** (`test-paths.ts`: `TEST_DIRS` at any depth,
  and `*.test.*`, `*.spec.*`, `*_test.go`, `test_*.py`, `*_test.py`, `conftest.py`, `*_spec.rb`;
  env files never count as test files) are skipped by `walk`, `selectTreeFiles` (so the App never
  fetches them) and `scanFiles`: no findings, variables or scopes from them; the CLI still reads
  their source so a test-only variable isn't UNUSED. `--include-tests` / `includeTests: true`.
- **Scanner accuracy (0.3.0)**, also in core: **declaration files** (`env-files.ts`: `.env.example`,
  `.env.sample`, `.env.template`, `.env.dist`, `.env.defaults`, `example.env`, `sample.env`,
  `env.example`, `.env.<name>.example|sample|template`) define variables and can be UNUSED; a
  commented `# KEY=` in one declares KEY (never UNUSED); MISMATCH stays `.env` vs `.env.example`;
  PR checks count any declaration file as declaring. **Vendored code** (`vendored.ts`) is never
  read: `VENDORED_DIRS` (not `build`: often build scripts), `.pnp.cjs`/`.pnp.loader.mjs`/`*.min.*`,
  and source files over 512 KB (`stat` in the CLI, blob sizes in `selectTreeFiles`, so the App
  never fetches them); the walk lists committed ones in `vendoredSkipped`/`tooLargeSkipped`.
  **Test tooling** joins `test-paths.ts` (`*.e2e.*`, `*.e2e-spec.*`, `*.cy.*`, runner configs and
  setup files, `playwright/`, `cypress/`, `mocks/`, `__mocks__/`, `testing/`). `scanSource` merges
  repeated reads on a line into one reference (a default only if every read has one), skips a
  match that is a whole quoted string (a bundler `define` key), and reads same-line destructuring
  (`{ <NAME>, <OTHER>: alias, <THIRD> = "x" } = process.env`; a non-nullish default is optional). **pydantic-settings**
  (`pydantic.ts`) fields are references (a `None` default counts only for a type that allows
  None). **Compose interpolation** (`compose.ts`) only marks names used in the file's scope, like
  test files (`usedOutsideCode`): never a reference, a variable or MISSING. Measure changes with
  `pnpm eval:repos` against the published CLI; never commit other projects' variable names.
- **The env parser never reads a value as a key** (`env-parser.ts`, 0.3.1): a quote that never
  closes makes the rest of the file that value and parsing stops (`unterminated`; `scanFiles`
  warns with file:line only); an unquoted `-----BEGIN …` (alone or as a value) skips every line
  through the next `-----END …` (none: the rest of the file, same warning).

- **One list of languages** (`languages.ts`, 0.3.2): `SUPPORTED_LANGUAGES` names each language
  the scanner reads and its extensions; `scanner.ts` builds its extension map from it and
  `test/languages.test.ts` pins the two together, so they can't drift. `SUPPORTED_LANGUAGES_OR` /
  `_AND` ("JS/TS, Python, Go, Ruby or PHP" / "… and PHP") word every message (the App's check
  runs, the CLI, the web app, the README, whose opening line and "Languages" limitation are tested
  against the constants). `UNREAD_SOURCE_EXTENSIONS` (`.java`, `.kt`, `.properties`, `.rs`, `.cs`,
  …) is only for saying what a repo holds that isn't read (counts by extension, never paths),
  never for scanning. `passesTreeRules()` (`scan.ts`) is the skip, vendored, build-output and
  test-path part of `selectTreeFiles`, which the App's coverage counts use for unread files too
  (with the tree's `treeMarkers`, so `storage/` beside `artisan` never counts).
- **PHP and Laravel** (Phase 5; the App on deploy, the CLI from 0.4.0). `.php` (Blade templates
  too): `getenv('X')`, `$_ENV['X']`, Laravel's `env('X')` (a function call: not `->env(`,
  `::env(` or `$env(`; `\env(` is) and `Env::get('X')`. Same-line defaults: `env('X', d)`,
  `Env::get('X', d)`, `env('X') ?? d` / `?: d` (also after a `null` second argument),
  `getenv('X') ?: d` (not `??`: getenv returns false), `$_ENV['X'] ?? d` / `?: d`; `null` (any
  case) and `?: throw …` are no default. `getenv`'s second argument is its local_only flag, never
  a default. **`$_SERVER['X']`** is a USED_ONLY read: it holds request data too, so it marks `X`
  used and never makes a reference or MISSING. **Symfony** (`symfony.ts`): `%env(X)%` in YAML
  under a `config/` directory is a reference, after any processors (`int:`, `json:file:`, …);
  `default:<param>:` with a non-empty parameter makes it optional (`default::X` falls back to
  null: no default); `#` comment lines are skipped. Config YAML is read but isn't a source file
  (`sourceFiles`), so it alone can't make a directory checkable. **Laravel** (`laravel.ts`): in a
  scope with an `artisan` file (the file is selected, never read), `LARAVEL_FRAMEWORK_NAMES` count
  as used (never UNUSED) and a read of one is treated as having a default (never MISSING:
  Laravel's published config reads `env('DB_URL')` with no default, null meaning "not set"). The
  list is the env vars laravel/framework reads itself, the union over its latest 11.x, 12.x and
  13.x tags: every literal `env('…')` in its `config/*.php` (merged into an app's config whether
  or not the app published the file) and the settings its `src/` reads outside `Testing/`
  (request data, the terminal, its own flags and names Laravel Cloud or Herd set are left out).
  Generated by `scripts/laravel-framework-names.mjs` (`pnpm laravel:names` reports per tag and
  checks the committed list; `--write` rewrites it); bump its pinned tags deliberately, review the
  report, never edit the list by hand. **Paths** (`build-dirs.ts`, `vendored.ts`,
  `test-paths.ts`): `bootstrap/cache/` and `public/build/` are skipped at any depth, `storage/`
  only beside `artisan` (a common folder name elsewhere), `.phpunit.cache` everywhere; Laravel's
  bootstrap/cache and storage can hold cached config with values, so they're never opened.
  `*Test.php` and `phpunit.xml(.dist)` are test tooling (`tests/` already was). Known misses:
  a call split across lines, dynamic names, `%env()%` in PHP or XML config, and names read only
  by Composer packages' unpublished config (UNUSED).
- **No supported source, no UNUSED** (decision 18, 0.3.2): when a whole scan reads no supported
  source file (`sourceFiles` 0, after the skip, vendored and test rules), `scanFiles` emits no
  UNUSED findings: nothing it reads could use them. MISMATCH stays (`.env` vs `.env.example` doesn't
  depend on the language). Repo-level, not per scope: a monorepo scope holding only Java and a
  `.env.example` next to JS scopes still gets UNUSED rows.

## Fixtures

- **Scanner fixtures:** `packages/core/test/fixtures/project` is deliberately broken and must stay
  in sync with the expectations in `test/scan.test.ts`; `fixtures/defaults` covers the quieter
  scan (every default form, the ignore list, the newer extensions and env file names, a scope with
  no env file) for `test/scan-defaults.test.ts`; `fixtures/accuracy` covers 0.3.0 (each declaration
  file name, commented declarations, test tooling, duplicate reads, pydantic-settings, Compose) for
  `test/scan-accuracy.test.ts`, whose vendored directories and >512 KB file are written at test
  time. `fixtures/laravel` covers PHP (`test/scan-php.test.ts`): every read and default form, the
  framework names (a `legacy/` scope without `artisan` where they're ordinary), `$_SERVER`, a
  `symfony/` scope, `*Test.php`; its `storage/`, `bootstrap/cache`, `public/build`,
  `.phpunit.cache` and `vendor/` decoys are written at test time. Their `.env`, `.env.local`, `.env.*.local`, `.env.production`, `.env.development` and
  `.env.test` files are committed through negations in the root `.gitignore`. Decoys (node_modules, dist,
  .git, …) are written into a temp copy at test time rather than committed. The scanner reads
  comments too, so write example code in comments as `process.env.<NAME>`. The fixtures sit under
  `test/`, which the scanner skips by default, but their tests scan the fixture directory itself
  as the root, so the rules apply to paths inside it.

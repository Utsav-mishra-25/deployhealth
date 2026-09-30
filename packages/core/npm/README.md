# deployhealth-scan

Find env var drift in a repository and report it to
[deployhealth](https://github.com/Utsav-mishra-25/deployhealth):

- **MISSING**: read in code (`process.env.X`, `os.environ["X"]`, `os.Getenv("X")`, `ENV["X"]`) but
  defined in no env file;
- **UNUSED**: defined in an env file but never read;
- **MISMATCH**: in `.env` but not `.env.example`, or the reverse.

It scans JavaScript/TypeScript (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`),
Python, Go and Ruby, respects `.gitignore`, and treats each folder with its own env files as a
separate scope (monorepos). It reads `.env.example`, `.env`, `.env.local`, `.env.development`,
`.env.production`, `.env.test` and their `.local` variants. One file, no dependencies, Node 20+.

A first scan stays quiet:

- **Names the platform or runtime provides are skipped**: `NODE_ENV`, `CI`, `npm_*`, GitHub
  Actions' default variables (`GITHUB_SHA`, `GITHUB_REF_NAME`, …, not your own `GITHUB_` names),
  `RUNNER_*`, `VERCEL_*`, `RAILWAY_*`, `RENDER_*`, `FLY_*` and a few more. `--no-default-ignore`
  checks them too; `--dry-run` lists what was skipped.
- **A read with a default on the same line isn't MISSING**: `process.env.X ?? "a"` or `|| "a"`,
  `os.getenv("X", "a")`, `os.environ.get("X", "a")`, `os.getenv("X") or "a"`, `ENV.fetch("X", "a")`,
  `ENV.fetch("X") { … }`, `ENV["X"] || "a"`. Such variables are listed as optional. (A default of
  `undefined`, `null`, `None` or `nil` is no default.)
- **A folder with no env file at all gets one line**, "No .env.example …: N variables referenced",
  instead of a MISSING row per reference; deployhealth's handoff offers them as a starting
  `.env.example`.

## Try it locally

```sh
npx deployhealth-scan@0.2.0 --dry-run          # grouped findings with file:line
npx deployhealth-scan@0.2.0 --dry-run --json   # the same, as JSON
```

With `--dry-run` nothing leaves your machine.

## Report every push from GitHub Actions

Create a project in deployhealth, add its ingest token as the repository secret
`DEPLOYHEALTH_TOKEN`, then add `.github/workflows/deployhealth.yml`:

```yaml
name: deployhealth

# Must not run on pull_request events from forks: the job reads a repository secret.
on:
  push:
    branches: [main]

jobs:
  env-scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          package-manager-cache: false
      - name: Scan env vars and report to deployhealth
        env:
          DEPLOYHEALTH_TOKEN: ${{ secrets.DEPLOYHEALTH_TOKEN }}
        run: |
          npx --yes deployhealth-scan@0.2.0 \
            --url https://deployhealth.dev \
            --token "$DEPLOYHEALTH_TOKEN" \
            --sha "$GITHUB_SHA" \
            --branch "$GITHUB_REF_NAME"
```

Pin the version (`@0.2.0`) so an update never runs in your CI unreviewed. For a self-hosted
deployhealth, change `--url` to your instance.

## What it sends

The commit sha and branch, and for each finding the variable name, `file:line` and env file name,
plus every referenced variable name with the env files that define it (and whether the code has a
default), and each scope's env file names. **Never values:** the scanner reads env files for the
names they define; values are neither sent nor printed.

## Options

```
--url <url>          deployhealth base URL (required unless --dry-run)
--token <token>      the project's ingest token, dh_... (required unless --dry-run)
--sha <sha>          commit being deployed (default: git rev-parse HEAD)
--branch <name>      branch being deployed (default: current git branch)
--dir <path>         directory to scan (default: current directory)
--ignore <glob>      skip variables matching a glob, e.g. NEXT_PUBLIC_* (repeatable)
--no-default-ignore  also check names the platform or runtime provides (NODE_ENV,
                     CI, GITHUB_SHA, npm_*, VERCEL_*, RAILWAY_*, RENDER_*, FLY_*, ...)
--exclude <pattern>  skip paths matching a gitignore-style pattern (repeatable)
--dry-run            print the findings instead of sending them
--json               with --dry-run, print JSON
-v, --version        print the version
-h, --help           show this help
```

Exit codes: `0` success, `1` the report failed (network or HTTP error), `2` usage error.

## License

MIT. The deployhealth web app and worker are licensed separately (FSL-1.1-MIT); see the
[repository](https://github.com/Utsav-mishra-25/deployhealth#licensing).

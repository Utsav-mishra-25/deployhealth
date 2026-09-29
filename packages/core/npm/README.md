# deployhealth-scan

Find env var drift in a repository and report it to
[deployhealth](https://github.com/Utsav-mishra-25/deployhealth):

- **MISSING**: read in code (`process.env.X`, `os.environ["X"]`, `os.Getenv("X")`, `ENV["X"]`) but
  defined in no env file;
- **UNUSED**: defined in an env file but never read;
- **MISMATCH**: in `.env` but not `.env.example`, or the reverse.

It scans JavaScript/TypeScript, Python, Go and Ruby, respects `.gitignore`, and treats each folder
with its own `.env.example` as a separate scope (monorepos). One file, no dependencies, Node 20+.

## Try it locally

```sh
npx deployhealth-scan@0.1.0 --dry-run          # grouped findings with file:line
npx deployhealth-scan@0.1.0 --dry-run --json   # the same, as JSON
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
          npx --yes deployhealth-scan@0.1.0 \
            --url https://deployhealth.dev \
            --token "$DEPLOYHEALTH_TOKEN" \
            --sha "$GITHUB_SHA" \
            --branch "$GITHUB_REF_NAME"
```

Pin the version (`@0.1.0`) so an update never runs in your CI unreviewed. For a self-hosted
deployhealth, change `--url` to your instance.

## What it sends

The commit sha and branch, and for each finding the variable name, `file:line` and env file name,
plus the list of variable names each env file defines. **Never values:** the scanner reads env
files for the names they define; values are neither sent nor printed.

## Options

```
--url <url>          deployhealth base URL (required unless --dry-run)
--token <token>      the project's ingest token, dh_... (required unless --dry-run)
--sha <sha>          commit being deployed (default: git rev-parse HEAD)
--branch <name>      branch being deployed (default: current git branch)
--dir <path>         directory to scan (default: current directory)
--ignore <glob>      skip variables matching a glob, e.g. NODE_ENV (repeatable)
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

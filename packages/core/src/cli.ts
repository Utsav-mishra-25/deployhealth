import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
// Type-only: the zod schema stays out of the CLI bundle. The server validates every payload.
import type { IngestPayload, IngestResponse } from './ingest';
import { scanProject, type ScanResult } from './scan';
import { TOKEN_SECRET_NAME } from './constants';
import { NO_SOURCE_FILES_LINE } from './languages';
import { SHA_PATTERN, type FindingKind } from './types';
import { CLI_VERSION } from './version';

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof fetch;
  /** Run git and return trimmed stdout, or null if git fails or is not installed. */
  git: (args: string[], cwd: string) => string | null;
  now: () => Date;
  /** The environment variables the CLI reads, by name (nothing else in the environment). */
  env: { DEPLOYHEALTH_TOKEN?: string };
}

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export const HELP = `Usage: deployhealth-scan [options]

Scan a repository for env var drift and report it to deployhealth.

Options:
  --url <url>          deployhealth base URL (required unless --dry-run)
  --token <token>      the project's ingest token, dh_... (required unless --dry-run;
                       default: the DEPLOYHEALTH_TOKEN environment variable)
  --sha <sha>          commit being deployed (default: git rev-parse HEAD)
  --branch <name>      branch being deployed (default: current git branch)
  --dir <path>         directory to scan (default: current directory)
  --ignore <glob>      skip variables matching a glob, e.g. NEXT_PUBLIC_* (repeatable)
  --no-default-ignore  also check names the platform or runtime provides (NODE_ENV,
                       CI, GITHUB_SHA, npm_*, VERCEL_*, RAILWAY_*, RENDER_*, FLY_*, ...)
  --exclude <pattern>  skip paths matching a gitignore-style pattern (repeatable)
  --include-tests      also scan tests, fixtures and test tooling (test/, tests/, e2e/,
                       fixtures/, playwright/, testing/, *.test.*, *.spec.*, *.e2e.*,
                       *_test.go, vitest.config.*, ...)
  --dry-run            print the findings instead of sending them
  --show-optional      with --dry-run, list each variable read with a default (OPTIONAL)
  --json               with --dry-run, print JSON (always lists them)
  -v, --version        print the version
  -h, --help           show this help
`;

const OPTIONS = {
  url: { type: 'string' },
  token: { type: 'string' },
  sha: { type: 'string' },
  branch: { type: 'string' },
  dir: { type: 'string' },
  ignore: { type: 'string', multiple: true },
  'no-default-ignore': { type: 'boolean' },
  'include-tests': { type: 'boolean' },
  exclude: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  'show-optional': { type: 'boolean' },
  json: { type: 'boolean' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Run the CLI. `argv` excludes the node and script paths. Returns the exit code. */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }));
  } catch (error) {
    io.stderr(`deployhealth-scan: ${(error as Error).message}\n\n${HELP}`);
    return EXIT.usage;
  }
  if (values.help) {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (values.version) {
    io.stdout(`${CLI_VERSION}\n`);
    return EXIT.ok;
  }

  const root = resolve(io.cwd, values.dir ?? '.');
  const result = await scanProject(root, {
    ignore: values.ignore,
    exclude: values.exclude,
    defaultIgnore: !values['no-default-ignore'],
    includeTests: values['include-tests'],
  });
  for (const w of result.warnings) io.stderr(`warning ${w.file}${w.line ? `:${w.line}` : ''}: ${w.message}\n`);

  // No source file in a language the scanner reads: say so plainly, never fail anyone's CI.
  const canCheck = result.sourceFiles > 0;
  if (values['dry-run']) {
    if (values.json) {
      if (!canCheck) io.stderr(`${NO_SOURCE_FILES_LINE}\n`);
      io.stdout(`${JSON.stringify(toJson(result), null, 2)}\n`);
    } else io.stdout(renderText(result, values['show-optional'] === true));
    return EXIT.ok;
  }

  const token = values.token || io.env.DEPLOYHEALTH_TOKEN || undefined;
  if (!values.url || !token) {
    io.stderr(`deployhealth-scan: --url and --token (or ${TOKEN_SECRET_NAME}) are required (or pass --dry-run)\n`);
    return EXIT.usage;
  }
  if (isPlainHttpToRemote(values.url)) {
    io.stderr('deployhealth-scan: warning: --url is plain http; the token and the report are sent unencrypted\n');
  }

  const sha = values.sha ?? io.git(['rev-parse', 'HEAD'], root);
  const branch = values.branch ?? io.git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (!sha || !branch || branch === 'HEAD') {
    io.stderr('deployhealth-scan: could not determine the commit and branch from git; pass --sha and --branch\n');
    return EXIT.usage;
  }

  if (!SHA_PATTERN.test(sha)) {
    io.stderr(`deployhealth-scan: --sha must be a hex commit id, got "${sha}"\n`);
    return EXIT.usage;
  }
  const payload: IngestPayload = {
    sha,
    branch,
    timestamp: io.now().toISOString(),
    findings: result.findings,
    variables: result.variables,
    env_scopes: result.envScopes,
  };

  // Still sent, so the deploy is recorded; the project page explains a scan with no references.
  if (!canCheck) io.stdout(`${NO_SOURCE_FILES_LINE}\n`);
  const endpoint = `${values.url.replace(/\/+$/, '')}/api/ingest/scan`;
  let response: Response;
  try {
    response = await io.fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    io.stderr(`deployhealth-scan: could not reach ${endpoint}: ${(error as Error).message}\n`);
    return EXIT.failed;
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    io.stderr(`deployhealth-scan: ingest failed with HTTP ${response.status}: ${body}\n`);
    return EXIT.failed;
  }

  const body = (await response.json()) as IngestResponse;
  const { missing, unused, mismatch } = body.counts;
  io.stdout(
    `deployhealth: reported ${sha.slice(0, 7)} on ${branch}: ` +
      `${missing} missing, ${unused} unused, ${mismatch} mismatch (deploy ${body.deployId})\n`,
  );
  return EXIT.ok;
}

/** `http:` to anything but this machine (localhost, *.localhost, 127.0.0.0/8, ::1). */
export function isPlainHttpToRemote(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false; // the request itself reports a bad URL
  }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '::1';
  return !local;
}

function toJson(result: ScanResult) {
  return {
    /** Source files read in a language the scanner reads; 0 → can_check false. */
    source_files: result.sourceFiles,
    can_check: result.sourceFiles > 0,
    counts: result.counts,
    scopes: result.scopes,
    env_scopes: result.envScopes,
    findings: result.findings,
    variables: result.variables,
    default_ignored: result.defaultIgnored,
    test_files_skipped: result.testFilesSkipped,
    vendored_skipped: result.vendoredSkipped,
    too_large_skipped: result.tooLargeSkipped,
    warnings: result.warnings,
  };
}

const TITLES: Record<FindingKind, string> = { missing: 'MISSING', unused: 'UNUSED', mismatch: 'MISMATCH' };

function renderText(result: ScanResult, showOptional: boolean): string {
  const scopes = result.scopes.map((s) => s || '(root)').join(', ');
  const out = [`deployhealth-scan: ${result.sourceFiles} source files, scopes: ${scopes}`, ''];
  if (result.sourceFiles === 0) out.push(NO_SOURCE_FILES_LINE, '');
  for (const kind of ['missing', 'unused', 'mismatch'] as const) {
    const rows = result.findings.filter((f) => f.kind === kind);
    out.push(`${TITLES[kind]} (${result.counts[kind]})`);
    if (rows.length === 0) out.push('  none');
    for (const f of rows) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '';
      const extra = kind === 'mismatch' ? ` (missing from ${f.env_file})` : '';
      out.push(`  ${f.var_name.padEnd(28)} ${where}${extra}`);
    }
    out.push('');
  }

  // One line by default: a Laravel app reads dozens of settings with a default, which aren't findings.
  const optional = result.variables.filter((v) => v.optional && v.defined_in.length === 0);
  if (optional.length > 0 && !showOptional) {
    out.push(`OPTIONAL (${optional.length}): read with a default; --show-optional lists them`, '');
  } else if (optional.length > 0) {
    out.push(`OPTIONAL (${optional.length}): a default in code, not defined in an env file`);
    for (const v of optional) out.push(`  ${v.var_name.padEnd(28)} ${v.scope || '(root)'}`);
    out.push('');
  }

  for (const { scope } of result.envScopes.filter((s) => s.env_files.length === 0)) {
    const count = result.variables.filter((v) => v.scope === scope).length;
    if (count === 0) continue;
    out.push(`No .env.example in ${scope || 'the repository root'}: ${count} variable${count === 1 ? '' : 's'} referenced (--json lists them).`);
    out.push('');
  }

  if (result.testFilesSkipped > 0) {
    const files = result.testFilesSkipped === 1 ? 'file' : 'files';
    out.push(`Skipped ${result.testFilesSkipped} test and fixture ${files} (read only to see which variables they use). --include-tests includes them.`);
    out.push('');
  }

  if (result.vendoredSkipped.length > 0) {
    out.push(`Skipped vendored and generated code: ${listSome(result.vendoredSkipped)}.`);
    out.push('');
  }

  if (result.tooLargeSkipped.length > 0) {
    const count = result.tooLargeSkipped.length;
    out.push(`Skipped ${count} file${count === 1 ? '' : 's'} over 512 KB (bundles, not code people wrote): ${listSome(result.tooLargeSkipped)}.`);
    out.push('');
  }

  if (result.defaultIgnored.length > 0) {
    out.push(`Skipped (the platform or runtime provides them): ${result.defaultIgnored.join(', ')}. --no-default-ignore includes them.`);
    out.push('');
  }
  return `${out.join('\n')}`;
}

/** The first few paths, then how many more `--json` lists. */
function listSome(paths: readonly string[], shown = 5): string {
  const more = paths.length - shown;
  return more > 0 ? `${paths.slice(0, shown).join(', ')} and ${more} more (--json lists them)` : paths.join(', ');
}

/** Real process I/O, used by bin.ts. */
export const nodeIo = (): CliIo => ({
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  fetch: globalThis.fetch,
  git: (args, cwd) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  },
  now: () => new Date(),
  env: { DEPLOYHEALTH_TOKEN: process.env.DEPLOYHEALTH_TOKEN },
});

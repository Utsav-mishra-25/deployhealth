import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
// Type-only: the zod schema stays out of the CLI bundle. The server validates every payload.
import type { IngestPayload, IngestResponse } from './ingest';
import { scanProject, type ScanResult } from './scan';
import { SHA_PATTERN, type FindingKind } from './types';

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fetch: typeof fetch;
  /** Run git and return trimmed stdout, or null if git fails or is not installed. */
  git: (args: string[], cwd: string) => string | null;
  now: () => Date;
}

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export const HELP = `Usage: deployhealth-scan [options]

Scan a repository for env var drift and report it to deployhealth.

Options:
  --url <url>          deployhealth base URL (required unless --dry-run)
  --token <token>      the project's ingest token, dh_... (required unless --dry-run)
  --sha <sha>          commit being deployed (default: git rev-parse HEAD)
  --branch <name>      branch being deployed (default: current git branch)
  --dir <path>         directory to scan (default: current directory)
  --ignore <glob>      skip variables matching a glob, e.g. NODE_ENV (repeatable)
  --exclude <pattern>  skip paths matching a gitignore-style pattern (repeatable)
  --dry-run            print the findings instead of sending them
  --json               with --dry-run, print JSON
  -h, --help           show this help
`;

const OPTIONS = {
  url: { type: 'string' },
  token: { type: 'string' },
  sha: { type: 'string' },
  branch: { type: 'string' },
  dir: { type: 'string' },
  ignore: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
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

  const root = resolve(io.cwd, values.dir ?? '.');
  const result = await scanProject(root, { ignore: values.ignore, exclude: values.exclude });
  for (const w of result.warnings) io.stderr(`warning ${w.file}${w.line ? `:${w.line}` : ''}: ${w.message}\n`);

  if (values['dry-run']) {
    io.stdout(values.json ? `${JSON.stringify(toJson(result), null, 2)}\n` : renderText(result));
    return EXIT.ok;
  }

  if (!values.url || !values.token) {
    io.stderr('deployhealth-scan: --url and --token are required (or pass --dry-run)\n');
    return EXIT.usage;
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
  const payload: IngestPayload = { sha, branch, timestamp: io.now().toISOString(), findings: result.findings };

  const endpoint = `${values.url.replace(/\/+$/, '')}/api/ingest/scan`;
  let response: Response;
  try {
    response = await io.fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${values.token}`, 'content-type': 'application/json' },
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

function toJson(result: ScanResult) {
  return { counts: result.counts, scopes: result.scopes, findings: result.findings, warnings: result.warnings };
}

const TITLES: Record<FindingKind, string> = { missing: 'MISSING', unused: 'UNUSED', mismatch: 'MISMATCH' };

function renderText(result: ScanResult): string {
  const scopes = result.scopes.map((s) => s || '(root)').join(', ');
  const out = [`deployhealth-scan: ${result.sourceFiles} source files, scopes: ${scopes}`, ''];
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
  return `${out.join('\n')}`;
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
});

import { appendFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { summarize } from '../src/findings';
import { scanFiles, scanProject, selectTreeFiles } from '../src/scan';
import type { FindingRow } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/project/', import.meta.url));

/** Files that must never be scanned, written into a temp copy of the fixture. */
const DECOYS: Record<string, string> = {
  'node_modules/lib/index.js': 'process.env.FROM_NODE_MODULES',
  'dist/bundle.js': 'process.env.FROM_DIST',
  '.next/server.js': 'process.env.FROM_NEXT_BUILD',
  '.git/hooks/pre-commit.js': 'process.env.FROM_GIT_DIR',
  'venv/lib/site.py': 'os.getenv("FROM_VENV")',
  'generated/client.ts': 'process.env.FROM_GITIGNORED_DIR',
  'README.md': 'process.env.FROM_MARKDOWN',
};

const missing = (var_name: string, file: string, line: number): FindingRow => ({
  kind: 'missing',
  var_name,
  file,
  line,
  env_file: null,
});
const unused = (var_name: string, file: string, line: number): FindingRow => ({
  kind: 'unused',
  var_name,
  file,
  line,
  env_file: file,
});
const mismatch = (var_name: string, file: string, line: number, absentFrom: string): FindingRow => ({
  kind: 'mismatch',
  var_name,
  file,
  line,
  env_file: absentFrom,
});

const EXPECTED: FindingRow[] = [
  missing('API_KEY', 'apps/admin/src/index.ts', 3), // defined at the root, but not in apps/admin's scope
  missing('AWS_REGION', 'src/server.ts', 5),
  missing('GO_TOKEN', 'cmd/api/main.go', 7),
  missing('LOG_LEVEL', 'src/server.ts', 4),
  // NODE_ENV (src/server.ts:6) is runtime-provided: skipped by default.
  missing('REGION', 'cmd/api/main.go', 8),
  missing('SMTP_HOST', 'lib/mailer.rb', 2),
  // lib/mailer.rb:3 is ENV.fetch("SMTP_HOST", "localhost"): it has a default, so it isn't MISSING.
  missing('VITE_FEATURE_FLAG', 'src/App.tsx', 3),
  missing('WORKER_DEBUG', 'worker/tasks.py', 5),
  unused('DATABASE_URL', 'apps/admin/.env.example', 2), // only root-scope code reads it
  unused('LEGACY_TOKEN', '.env', 4),
  unused('LOCAL_ONLY', '.env.local', 2),
  unused('OLD_FLAG', '.env.example', 5),
  mismatch('LEGACY_TOKEN', '.env', 4, '.env.example'),
  mismatch('OLD_FLAG', '.env.example', 5, '.env'),
  mismatch('SENTRY_DSN', '.env.example', 4, '.env'),
];

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'deployhealth-scan-'));
  await cp(FIXTURE, root, { recursive: true });
  for (const [rel, content] of Object.entries(DECOYS)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  // Real projects gitignore their env files; the scanner must still read them.
  await appendFile(join(root, '.gitignore'), '.env\n.env.local\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Every file under `dir` (like a git tree that committed everything), POSIX paths. */
async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split('\\').join('/'));
}

describe('scanFiles + selectTreeFiles (git trees)', () => {
  it('select the same files as scanProject, except tracked files a .gitignore matches, and give the same result for them', async () => {
    const paths = await allFiles(root);
    expect(paths).toEqual(expect.arrayContaining(['node_modules/lib/index.js', 'generated/client.ts', 'README.md']));
    const selected = selectTreeFiles(paths);
    expect(selected).not.toEqual(expect.arrayContaining(['node_modules/lib/index.js']));
    expect(selected).toEqual(expect.arrayContaining(['.env', '.env.local', 'src/server.ts']));
    // git never ignores a file it tracks: generated/ is in .gitignore, but a tree only lists committed files.
    expect(selected).toContain('generated/client.ts');
    const withoutIgnored = selected.filter((p) => !p.startsWith('generated/'));
    const files = new Map(await Promise.all(withoutIgnored.map(async (p) => [p, await readFile(join(root, p), 'utf8')] as const)));
    // Only the directory walk lists the vendored directories it skipped; the tree selection already left them out.
    const fromDir = await scanProject(root);
    expect(fromDir.vendoredSkipped).toEqual(['.next/', 'dist/', 'node_modules/', 'venv/']);
    expect(await scanFiles(files)).toEqual({ ...fromDir, vendoredSkipped: [] });
  });

  it('never applies .gitignore files to a tree (nor fetches them), but still skips vendored directories at any depth', () => {
    const paths = [
      '.gitignore',
      'build/.gitignore',
      'build/out.ts',
      'node_modules/.gitignore',
      'node_modules/x/index.ts',
      'packages/a/.gitignore',
      'packages/a/secret.ts',
      'packages/a/.env',
      'packages/a/index.ts',
      'packages/a/node_modules/lib/index.ts',
    ];
    expect(selectTreeFiles(paths)).toEqual(['build/out.ts', 'packages/a/.env', 'packages/a/index.ts', 'packages/a/secret.ts']);
  });
});

describe('scanProject on the fixture', () => {
  it('reports every finding in the stored shape, sorted', async () => {
    const result = await scanProject(root);
    expect(result.findings).toEqual(EXPECTED);
    expect(result.warnings).toEqual([]);
  });

  it('counts distinct variable names per kind', async () => {
    const result = await scanProject(root);
    expect(result.counts).toEqual({ missing: 8, unused: 4, mismatch: 3 });
  });

  it('skips runtime-provided names by default, says which, and brings them back with defaultIgnore: false', async () => {
    const result = await scanProject(root);
    expect(result.defaultIgnored).toEqual(['NODE_ENV']);
    expect(result.variables.map((x) => x.var_name)).not.toContain('NODE_ENV');
    const all = await scanProject(root, { defaultIgnore: false });
    expect(all.defaultIgnored).toEqual([]);
    expect(all.findings).toContainEqual(missing('NODE_ENV', 'src/server.ts', 6));
    expect(all.counts.missing).toBe(9);
  });

  it('reports each scope with the env files it has', async () => {
    const result = await scanProject(root);
    expect(result.envScopes).toEqual([
      { scope: '', env_files: ['.env.example', '.env', '.env.local'] },
      { scope: 'apps/admin', env_files: ['.env.example'] },
    ]);
  });

  it('checks each file against its nearest env scope', async () => {
    const result = await scanProject(root);
    expect(result.scopes).toEqual(['', 'apps/admin']);
    expect(result.envFiles).toEqual(['.env', '.env.example', '.env.local', 'apps/admin/.env.example']);
    expect(result.sourceFiles).toBe(6);
  });

  it('lists every referenced variable per scope with the env files that define it, names only', async () => {
    const result = await scanProject(root);
    const v = (var_name: string, scope: string, defined_in: string[]) => ({ var_name, scope, defined_in });
    expect(result.variables).toEqual([
      v('API_KEY', '', ['.env.example', '.env']),
      v('AWS_REGION', '', []),
      v('DATABASE_URL', '', ['.env.example', '.env']),
      v('GO_TOKEN', '', []),
      v('LOG_LEVEL', '', []),
      v('PORT', '', ['.env.example', '.env']),
      v('REGION', '', []),
      v('SENTRY_DSN', '', ['.env.example']),
      v('SMTP_HOST', '', []),
      v('VITE_API_URL', '', ['.env.local']),
      v('VITE_FEATURE_FLAG', '', []),
      v('WORKER_DEBUG', '', []),
      v('ADMIN_SECRET', 'apps/admin', ['.env.example']),
      v('API_KEY', 'apps/admin', []),
    ]);
    // Undefined in its scope is exactly what MISSING means.
    const undefinedNames = new Set(result.variables.filter((x) => x.defined_in.length === 0).map((x) => x.var_name));
    expect(undefinedNames).toEqual(new Set(result.findings.filter((f) => f.kind === 'missing').map((f) => f.var_name)));
    // Unused and env-only names (LEGACY_TOKEN, OLD_FLAG, LOCAL_ONLY) aren't required, so they're not listed.
    expect(result.variables.map((x) => x.var_name)).not.toEqual(expect.arrayContaining(['LEGACY_TOKEN']));
  });

  it('leaves ignored names out of the variable list too', async () => {
    const result = await scanProject(root, { ignore: ['NODE_ENV', 'VITE_*'] });
    expect(result.variables.map((x) => x.var_name)).not.toEqual(expect.arrayContaining(['NODE_ENV']));
    expect(result.variables.some((x) => x.var_name.startsWith('VITE_'))).toBe(false);
  });

  it('never reads decoys', async () => {
    const names = (await scanProject(root)).findings.map((f) => f.var_name);
    expect(names.filter((n) => n.startsWith('FROM_'))).toEqual([]);
  });

  it('produces the same findings from the committed fixture', async () => {
    expect((await scanProject(FIXTURE)).findings).toEqual(EXPECTED);
  });

  it('drops ignored names from every kind', async () => {
    const result = await scanProject(root, { ignore: ['NODE_ENV', 'SMTP_*', 'LEGACY_*'] });
    const names = result.findings.map((f) => f.var_name);
    expect(names).not.toContain('NODE_ENV');
    expect(names).not.toContain('SMTP_HOST');
    expect(names).not.toContain('LEGACY_TOKEN');
    expect(result.counts).toEqual({ missing: 7, unused: 3, mismatch: 2 });
  });

  it('leaves excluded paths out entirely, including their env files', async () => {
    const result = await scanProject(root, { exclude: ['apps/'] });
    expect(result.scopes).toEqual(['']);
    expect(result.findings.some((f) => f.file?.startsWith('apps/'))).toBe(false);
  });
});

describe('scanProject edge cases', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deployhealth-edge-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a scope with no env file once, instead of a MISSING row per reference', async () => {
    await mkdir(join(dir, 'none'), { recursive: true });
    await writeFile(join(dir, 'none/a.ts'), 'process.env.ONLY_ONE\nprocess.env.ONLY_ONE\n');
    const result = await scanProject(join(dir, 'none'));
    expect(result.findings).toEqual([]);
    expect(result.scopes).toEqual(['']);
    expect(result.envScopes).toEqual([{ scope: '', env_files: [] }]);
    expect(result.variables).toEqual([{ var_name: 'ONLY_ONE', scope: '', defined_in: [] }]);
  });

  it('warns about unparsable env lines without failing', async () => {
    await mkdir(join(dir, 'warn'), { recursive: true });
    await writeFile(join(dir, 'warn/.env.example'), 'GOOD=1\nnot an assignment\n');
    const result = await scanProject(join(dir, 'warn'));
    expect(result.warnings).toEqual([{ file: '.env.example', line: 2, message: 'ignored a line that is not KEY=value' }]);
    expect(result.findings).toEqual([unused('GOOD', '.env.example', 1)]);
  });
});

describe('summarize', () => {
  it('counts each variable once per kind', () => {
    expect(
      summarize([
        { kind: 'missing', var_name: 'A' },
        { kind: 'missing', var_name: 'A' },
        { kind: 'missing', var_name: 'B' },
        { kind: 'mismatch', var_name: 'A' },
      ]),
    ).toEqual({ missing: 2, unused: 0, mismatch: 1 });
  });
});

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanFiles, scanProject, selectTreeFiles } from '../src/scan';
import type { FindingRow } from '../src/types';
import { MAX_SOURCE_FILE_BYTES } from '../src/vendored';

// Scanner accuracy on real repositories (0.3.0): declaration files besides .env.example, vendored
// and generated code, test tooling, duplicate reads, pydantic-settings and Compose interpolation.
const FIXTURE = fileURLToPath(new URL('./fixtures/accuracy/', import.meta.url));

const unused = (var_name: string, file: string, line: number): FindingRow => ({ kind: 'unused', var_name, file, line, env_file: file });

describe('declaration files besides .env.example', () => {
  const NAMES = {
    sample: '.env.sample',
    template: '.env.template',
    'dotenv-dist': '.env.dist',
    defaults: '.env.defaults',
    'example-env': 'example.env',
    'sample-env': 'sample.env',
    'env-example': 'env.example',
    'named-example': '.env.appStore.example',
    'named-sample': '.env.local.sample',
    'named-template': '.env.ci-runner.template',
  };

  it('each one makes a scope and declares its variables, which can be UNUSED', async () => {
    const result = await scanProject(`${FIXTURE}env-names`);
    for (const [dir, name] of Object.entries(NAMES)) {
      expect(result.envScopes, dir).toContainEqual({ scope: dir, env_files: [name] });
      expect(result.variables, dir).toContainEqual({ var_name: 'DECLARED', scope: dir, defined_in: [name] });
      expect(result.findings, dir).toContainEqual(unused('LEFTOVER', `${dir}/${name}`, 2));
    }
    expect(result.findings.filter((f) => f.kind === 'missing')).toEqual([]);
  });

  it('ignores other names (.env.staging, a dotted .env.<a>.<b>.example)', async () => {
    const result = await scanProject(`${FIXTURE}env-names`);
    expect(result.envFiles.filter((f) => f.startsWith('ignored-'))).toEqual([]);
    // Their code falls into the root scope, which has no env file: listed, never MISSING.
    expect(result.envScopes).toContainEqual({ scope: '', env_files: [] });
    expect(result.variables).toContainEqual({ var_name: 'NOT_READ', scope: '', defined_in: [] });
  });

  it('still compares only .env with .env.example for MISMATCH', async () => {
    const result = await scanProject(`${FIXTURE}env-names/mixed`);
    expect(result.envScopes).toEqual([{ scope: '', env_files: ['.env.example', '.env', '.env.sample'] }]);
    expect(result.variables).toEqual([
      { var_name: 'SAMPLE_ONLY', scope: '', defined_in: ['.env.sample'] },
      { var_name: 'SHARED', scope: '', defined_in: ['.env.example', '.env', '.env.sample'] },
    ]);
    expect(result.findings).toEqual([]);
  });
});

/** Every file under `dir`, POSIX paths (like a git tree that committed everything). */
async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split('\\').join('/'));
}

describe('vendored and generated code', () => {
  const VENDORED_DIRS = ['.yarn/releases', 'vendor', 'third_party', 'bower_components/lib', 'out', 'coverage', '.turbo', '.vercel', '.output', '.svelte-kit', '.nuxt', '.cache', '.pnpm-store', '__pycache__', 'lib/site-packages', 'packages/a/node_modules/x'];
  const GENERATED = ['.pnp.cjs', '.pnp.loader.mjs', 'public/app.min.js', 'public/app.min.mjs', 'public/app.min.cjs'];
  // Written at test time: the root .gitignore would drop some of these from the commit anyway.
  const big = (name: string, bytes: number) => {
    const line = `export const v = process.env.${name};\n`;
    return line + '/'.repeat(bytes - line.length - 1) + '\n';
  };
  const TREE: Record<string, string> = {
    '.gitignore': 'ignored-modules/\n',
    '.env.example': 'APP_KEY=\nBOUNDARY_VAR=\nBUILD_SCRIPT_VAR=\n',
    'src/app.ts': 'export const key = process.env.APP_KEY;\n',
    // A committed build/ is read: it is often build scripts (decision: `build` isn't vendored).
    'build/webpack.config.js': 'module.exports = { mode: process.env.BUILD_SCRIPT_VAR };\n',
    'src/huge.js': big('FROM_HUGE_BUNDLE', MAX_SOURCE_FILE_BYTES + 1),
    'src/boundary.js': big('BOUNDARY_VAR', MAX_SOURCE_FILE_BYTES),
    'ignored-modules/node_modules/x.js': 'process.env.FROM_IGNORED',
    'assets/vendor/logo.svg': '<svg/>', // a vendored directory with nothing to scan isn't listed
    'test/vendor/helper.js': 'process.env.FROM_TEST_VENDOR', // nor one inside a test directory
    ...Object.fromEntries(VENDORED_DIRS.map((dir, i) => [`${dir}/file${i}.${dir.includes('py') ? 'py' : 'cjs'}`, dir.includes('py') ? `os.getenv("FROM_VENDORED_${i}")` : `process.env.FROM_VENDORED_${i}`])),
    ...Object.fromEntries(GENERATED.map((file, i) => [file, `process.env.FROM_GENERATED_${i}`])),
  };
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'deployhealth-vendored-'));
    for (const [rel, content] of Object.entries(TREE)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it('never reads vendored directories, generated files or source files over 512 KB', async () => {
    const result = await scanProject(root);
    expect(result.references.map((r) => r.name).filter((n) => n.startsWith('FROM_'))).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.variables.map((v) => v.var_name)).toEqual(['APP_KEY', 'BOUNDARY_VAR', 'BUILD_SCRIPT_VAR']);
  });

  it('lists what it skipped that nothing ignores: each vendored directory once, generated files, and files over 512 KB', async () => {
    const result = await scanProject(root);
    const dirs = ['.yarn/', 'vendor/', 'third_party/', 'bower_components/', 'out/', 'coverage/', '.turbo/', '.vercel/', '.output/', '.svelte-kit/', '.nuxt/', '.cache/', '.pnpm-store/', '__pycache__/', 'lib/site-packages/', 'packages/a/node_modules/'];
    expect(result.vendoredSkipped).toEqual([...dirs, ...GENERATED].sort());
    expect(result.tooLargeSkipped).toEqual(['src/huge.js']);
  });

  it('applies the same rules to a git tree, so the GitHub App never fetches vendored code or big files', async () => {
    const paths = await allFiles(root);
    const sizes = new Map(await Promise.all(paths.map(async (p) => [p, Buffer.byteLength(await readFile(join(root, p)))] as const)));
    const selected = await selectTreeFiles(paths, (p) => readFile(join(root, p), 'utf8'), { sizes });
    expect(selected).toEqual(['.env.example', 'build/webpack.config.js', 'src/app.ts', 'src/boundary.js']);
    const fromTree = await scanFiles(new Map(await Promise.all(selected.map(async (p) => [p, await readFile(join(root, p), 'utf8')] as const))));
    const fromDir = await scanProject(root);
    expect(fromTree.findings).toEqual(fromDir.findings);
    expect(fromTree.variables).toEqual(fromDir.variables);
    expect(fromTree.references).toEqual(fromDir.references);
    // Without sizes, scanFiles still refuses to read a file over the limit.
    const unsized = await selectTreeFiles(paths, (p) => readFile(join(root, p), 'utf8'));
    expect(unsized).toContain('src/huge.js');
    const fromUnsized = await scanFiles(new Map(await Promise.all(unsized.map(async (p) => [p, await readFile(join(root, p), 'utf8')] as const))));
    expect(fromUnsized.tooLargeSkipped).toEqual(['src/huge.js']);
    expect(fromUnsized.findings).toEqual(fromDir.findings);
  });
});

describe('test tooling counts as tests', () => {
  const ROOT = `${FIXTURE}test-tooling`;

  it('skips *.e2e.*, *.cy.*, test runner configs and setup files, and playwright/, cypress/, mocks/, __mocks__/ and testing/', async () => {
    const result = await scanProject(ROOT);
    expect(result.variables).toEqual([
      { var_name: 'APP_KEY', scope: '', defined_in: ['.env.example'] },
      { var_name: 'UTILS_VAR', scope: '', defined_in: [] }, // src/testing-utils.ts isn't in a testing/ directory
    ]);
    expect(result.testFilesSkipped).toBe(14);
    // Variables only test tooling reads are used, not UNUSED; .env.e2e.example is an env file, not a test.
    expect(result.envScopes).toEqual([{ scope: '', env_files: ['.env.example', '.env.e2e.example'] }]);
    expect(result.findings).toEqual([{ kind: 'missing', var_name: 'UTILS_VAR', file: 'src/testing-utils.ts', line: 1, env_file: null }]);
  });

  it('the GitHub App never fetches them', async () => {
    const paths = await allFiles(ROOT);
    expect(await selectTreeFiles(paths, (p) => readFile(join(ROOT, p), 'utf8'))).toEqual(['.env.e2e.example', '.env.example', 'src/app.ts', 'src/testing-utils.ts']);
  });
});

describe('one row per variable per file:line', () => {
  it('reports a line that reads a variable twice once, in findings, references and variables', async () => {
    const result = await scanProject(`${FIXTURE}duplicates`);
    expect(result.findings).toEqual([
      { kind: 'missing', var_name: 'DUP_REGION', file: 'config.ts', line: 1, env_file: null },
      { kind: 'missing', var_name: 'DUP_REGION', file: 'config.ts', line: 3, env_file: null },
    ]);
    expect(result.references.map((r) => `${r.name} ${r.file}:${r.line}`)).toEqual([
      'DUP_REGION config.ts:1',
      'DECLARED_TWICE config.ts:2',
      'DUP_REGION config.ts:3',
    ]);
  });
});

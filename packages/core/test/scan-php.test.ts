import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanFiles, scanProject, selectTreeFiles, type ScanResult } from '../src/scan';
import { scanSource } from '../src/scanner';
import { scanSymfonyConfig } from '../src/symfony';

// PHP and Laravel (Phase 5): every read and default form, the $_SERVER and framework-name rules,
// Symfony's %env()%, and the paths never read. The skipped directories are written into a temp
// copy at test time rather than committed.
const FIXTURE = fileURLToPath(new URL('./fixtures/laravel/', import.meta.url));
const JS_ENV = ['process', 'env'].join('.');

const DECOYS: Record<string, string> = {
  // Laravel's compiled views and cached config can hold values: never opened next to artisan.
  'storage/framework/views/5f1d.php': "<?php echo env('STORAGE_SECRET'); ?>",
  'bootstrap/cache/config.php': "<?php return ['key' => getenv('CACHED_CONFIG')];",
  'public/build/assets/app.js': `const a = ${JS_ENV}.BUILD_VAR;`,
  '.phpunit.cache/test-results.php': "<?php env('PHPUNIT_CACHE_VAR');",
  'vendor/laravel/framework/config/app.php': "<?php env('VENDOR_VAR');",
  // Still read: only bootstrap/cache is skipped.
  'bootstrap/app.php': "<?php env('BOOTSTRAP_APP', 'x');",
  // No artisan in legacy/: its storage/ is ordinary code; bootstrap/cache is skipped everywhere.
  'legacy/storage/Store.php': "<?php getenv('LEGACY_STORAGE_VAR');",
  'legacy/bootstrap/cache/packages.php': "<?php getenv('LEGACY_CACHED');",
};
const NEVER_SEEN = ['STORAGE_SECRET', 'CACHED_CONFIG', 'BUILD_VAR', 'PHPUNIT_CACHE_VAR', 'VENDOR_VAR', 'LEGACY_CACHED'];

let root: string;
let project: ScanResult;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dh-laravel-'));
  await cp(FIXTURE, root, { recursive: true });
  for (const [path, text] of Object.entries(DECOYS)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  project = await scanProject(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Distinct names of one kind in one scope: MISSING by its reference's scope, UNUSED by the scope's .env.example. */
const names = (result: ScanResult, kind: 'missing' | 'unused', scope = '') => {
  const scopeOf = new Map(result.references.map((r) => [`${r.file}:${r.line}:${r.name}`, r.scope]));
  const inScope = (f: ScanResult['findings'][number]) =>
    kind === 'missing' ? scopeOf.get(`${f.file}:${f.line}:${f.var_name}`) === scope : f.env_file === `${scope ? `${scope}/` : ''}.env.example`;
  return [...new Set(result.findings.filter((f) => f.kind === kind && inScope(f)).map((f) => f.var_name))].sort();
};
const optional = (result: ScanResult, scope = '') =>
  result.variables
    .filter((v) => v.scope === scope && v.optional)
    .map((v) => v.var_name)
    .sort();

describe('a Laravel app', () => {
  it('reads getenv, $_ENV, env() and Env::get, in code and Blade templates', () => {
    const read = new Set(project.references.filter((r) => r.scope === '').map((r) => r.name));
    for (const name of ['APP_NAME', 'APP_KEY', 'DB_HOST', 'MY_SERVICE_URL', 'MY_SERVICE_TIMEOUT', 'FEATURE_FLAG', 'OTHER_FLAG', 'GETENV_VAR', 'GETENV_OPT', 'GETENV_Q', 'GETENV_LOCAL', 'ENV_ARR', 'ENV_REQ', 'ENV_GET', 'ENV_GET2', 'THROWS', 'BLADE_VAR', 'BOOTSTRAP_APP']) {
      expect(read.has(name), name).toBe(true);
    }
    expect(project.references.find((r) => r.name === 'BLADE_VAR')).toMatchObject({ file: 'resources/views/welcome.blade.php', syntax: 'env()' });
    // Methods, other classes' static calls and $_SERVER are never references.
    for (const name of ['NOT_A_READ', 'NOT_A_READ_EITHER', 'SERVER_ONLY_VAR', 'HTTP_HOST']) expect(read.has(name), name).toBe(false);
  });

  it('a same-line default makes a read optional; null, throw, and ?? after getenv are no default', () => {
    expect(optional(project)).toEqual(['APP_NAME', 'BLADE_VAR', 'BOOTSTRAP_APP', 'DB_HOST', 'DB_URL', 'ENV_ARR', 'ENV_GET', 'GETENV_OPT', 'MY_SERVICE_TIMEOUT', 'OTHER_FLAG']);
    expect(names(project, 'missing')).toEqual(['ENV_GET2', 'FEATURE_FLAG', 'GETENV_LOCAL', 'GETENV_Q', 'THROWS']);
  });

  it("counts the framework's own names, $_SERVER reads and test-only reads as used; a framework name is never MISSING", () => {
    expect(names(project, 'unused')).toEqual(['UNUSED_THING', 'VITE_APP_NAME']);
    expect(project.references.map((r) => r.name)).not.toContain('BCRYPT_ROUNDS');
    // DB_URL is read with no default and declared nowhere, but it's the framework's setting.
    expect(project.variables).toContainEqual({ var_name: 'DB_URL', scope: '', defined_in: [], optional: true });
  });

  it('never reads storage/ next to artisan, bootstrap/cache, public/build, .phpunit.cache or vendor', () => {
    const seen = new Set([...project.references.map((r) => r.name), ...project.findings.map((f) => f.var_name)]);
    for (const name of NEVER_SEEN) expect(seen.has(name), name).toBe(false);
    expect(project.references.some((r) => r.file.startsWith('storage/') || r.file.includes('bootstrap/cache/'))).toBe(false);
  });

  it('treats *Test.php and phpunit.xml as test tooling', () => {
    expect(project.references.map((r) => r.file)).not.toContain('app/Http/HealthTest.php');
    expect(project.testFilesSkipped).toBeGreaterThanOrEqual(2);
  });
});

describe('APP_KEY', () => {
  it('stays never-UNUSED but can be MISSING next to artisan: Laravel needs it to boot', () => {
    expect(names(project, 'missing', 'nokey')).toEqual(['APP_KEY']);
    expect(optional(project, 'nokey')).toEqual(['APP_NAME', 'APP_URL']);
    expect(project.variables).toContainEqual({ var_name: 'APP_KEY', scope: '', defined_in: ['.env.example'] });
  });
});

describe('the framework names apply only next to artisan', () => {
  it('in legacy/ (no artisan) BCRYPT_ROUNDS is UNUSED, DB_URL can be MISSING, and storage/ is ordinary code', () => {
    expect(names(project, 'unused', 'legacy')).toEqual(['BCRYPT_ROUNDS']);
    expect(names(project, 'missing', 'legacy')).toEqual(['DB_URL', 'LEGACY_STORAGE_VAR']);
  });
});

describe("Symfony's %env()% in config YAML", () => {
  it('reads processors and default:<param>:, only under config/, never in comments', () => {
    const refs = project.references.filter((r) => r.scope === 'symfony' && r.syntax === '%env()%');
    expect(refs.map((r) => r.name).sort()).toEqual(['DATABASE_URL', 'MAILER_DSN', 'SF_HOST', 'SF_NULLDEF', 'SF_PORT']);
    expect(optional(project, 'symfony')).toEqual(['SF_HOST']);
    expect(names(project, 'missing', 'symfony')).toEqual(['SF_NULLDEF', 'SF_PORT']);
    expect(names(project, 'unused', 'symfony')).toEqual(['UNUSED_SF']);
  });

  it("YAML alone isn't source: a directory with only config YAML can't be checked", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dh-symfony-only-'));
    await mkdir(join(dir, 'config'));
    await writeFile(join(dir, 'config/services.yaml'), "a: '%env(ONLY_YAML)%'\n");
    await writeFile(join(dir, '.env.example'), 'ONLY_YAML=\nLEFTOVER=\n');
    const result = await scanProject(dir);
    expect(result.sourceFiles).toBe(0);
    expect(result.references.map((r) => r.name)).toEqual(['ONLY_YAML']);
    expect(result.findings.filter((f) => f.kind === 'unused')).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('a PHP directory with no env file', () => {
  it('lists its variables and scope, never MISSING', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dh-php-noenv-'));
    await writeFile(join(dir, 'index.php'), "<?php\n$a = env('NO_FILE_VAR');\n");
    const result = await scanProject(dir);
    expect(result.envScopes).toEqual([{ scope: '', env_files: [] }]);
    expect(result.variables).toEqual([{ var_name: 'NO_FILE_VAR', scope: '', defined_in: [] }]);
    expect(result.findings).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

/** Every file under `dir`, POSIX paths (like a git tree that committed everything). */
async function allFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await allFiles(dir, path)));
    else out.push(path);
  }
  return out;
}

describe('the GitHub App sees the same thing from the tree', () => {
  it('selects the same files (never fetching the skipped ones) and finds the same results', async () => {
    const tree = await allFiles(root);
    const selected = selectTreeFiles(tree);
    expect(selected).toContain('artisan');
    expect(selected.some((p) => p.startsWith('storage/') || p.includes('bootstrap/cache/') || p.startsWith('public/build/') || p.startsWith('.phpunit.cache/'))).toBe(false);
    expect(selected).toContain('legacy/storage/Store.php');
    const files = new Map(await Promise.all(selected.map(async (p) => [p, await readFile(join(root, p), 'utf8')] as const)));
    const fromTree = await scanFiles(files);
    // The App never fetches test files, so the two variables only tests read are UNUSED there.
    const testOnly = (f: ScanResult['findings'][number]) => f.kind === 'unused' && ['TEST_ONLY_VAR', 'UNIT_TEST_VAR'].includes(f.var_name);
    expect(fromTree.findings.filter((f) => !testOnly(f))).toEqual(project.findings);
    expect(fromTree.findings.filter(testOnly)).toHaveLength(2);
    expect(fromTree.variables).toEqual(project.variables);
  });
});

describe('scanSource for PHP, line by line', () => {
  const read = (line: string) => scanSource(line, 'php', 'a.php').map((r) => `${r.name}${r.hasDefault ? '?' : ''}`);

  it('each read form', () => {
    expect(read("getenv('A'); getenv(\"B\"); \\getenv('C', true);")).toEqual(['A', 'B', 'C']);
    expect(read("$_ENV['A'] . $_ENV[ \"B\" ]")).toEqual(['A', 'B']);
    expect(read("env('A'); \\env('B'); Env::get('C'); \\Illuminate\\Support\\Env::get('D');")).toEqual(['A', 'B', 'C', 'D']);
    expect(read("$this->env('A'); Foo::env('B'); $env('C'); myenv('D'); $app->getenv('E');")).toEqual([]);
  });

  it('each default form', () => {
    expect(read("env('A', 'x')")).toEqual(['A?']);
    expect(read("env('A', 0)")).toEqual(['A?']);
    expect(read("env('A', null)")).toEqual(['A']);
    expect(read("env('A', NULL) ?? 'x'")).toEqual(['A?']);
    expect(read("env('A') ?? 'x'")).toEqual(['A?']);
    expect(read("env('A') ?: 'x'")).toEqual(['A?']);
    expect(read("env('A') ?: null")).toEqual(['A']);
    expect(read("env('A') ?: throw new Exception()")).toEqual(['A']);
    expect(read("Env::get('A', 'x')")).toEqual(['A?']);
    expect(read("getenv('A') ?: 'x'")).toEqual(['A?']);
    expect(read("getenv('A') ?? 'x'")).toEqual(['A']);
    expect(read("getenv('A', true) ?: 'x'")).toEqual(['A?']);
    expect(read("$_ENV['A'] ?? 'x'")).toEqual(['A?']);
    expect(read("$_ENV['A'] ?: 'x'")).toEqual(['A?']);
    expect(read("$_ENV['A'] ?? null")).toEqual(['A']);
  });

  it('one reference per name per line, optional only if every read has a default', () => {
    expect(read("env('A', 'x') . env('A')")).toEqual(['A']);
    expect(read("env('A', 'x') . getenv('A') ?: 'y'")).toEqual(['A?']);
  });
});

describe('scanSymfonyConfig', () => {
  const read = (line: string) => scanSymfonyConfig(line, 'config/a.yaml').map((r) => `${r.name}${r.hasDefault ? '?' : ''}`);

  it('names after any processors; default:<param>: is a default, default:: is not', () => {
    expect(read("a: '%env(A)%'")).toEqual(['A']);
    expect(read("a: '%env(int:A)%' b: '%env(json:file:B)%'")).toEqual(['A', 'B']);
    expect(read("a: '%env(default:fallback:A)%'")).toEqual(['A?']);
    expect(read("a: '%env(default::A)%'")).toEqual(['A']);
    expect(read("a: '%env(A)%-%env(default:x:A)%'")).toEqual(['A']);
    expect(read("# a: '%env(A)%'")).toEqual([]);
    expect(read("a: '%env(a.b)%' b: '%env(A'")).toEqual([]);
  });
});

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE } from '../src/default-ignore';
import { createNameFilter } from '../src/glob';
import { scanFiles, scanProject } from '../src/scan';
import type { FindingRow, RequiredVariable } from '../src/types';

// The quieter first scan: inline defaults, the default ignore list, the newer JS extensions and
// env file names, and a scope with no env file. Separate from fixtures/project, which stays as is.
const FIXTURE = fileURLToPath(new URL('./fixtures/defaults/', import.meta.url));

const missing = (var_name: string, file: string, line: number): FindingRow => ({ kind: 'missing', var_name, file, line, env_file: null });
const v = (var_name: string, scope: string, defined_in: string[], optional = false) =>
  ({ var_name, scope, defined_in, ...(optional ? { optional: true } : {}) }) as RequiredVariable;

describe('scanProject on the defaults fixture', () => {
  it('reports MISSING only for references with no default, in scopes that have env files', async () => {
    const result = await scanProject(FIXTURE);
    expect(result.findings).toEqual([
      missing('CJS_ONLY', 'services/api/src/boot.cjs', 1),
      missing('CTS_ONLY', 'services/api/src/legacy.cts', 1),
      missing('MAILER_REGION', 'services/mailer/main.go', 6), // Go has no default form
      missing('MISSING_ONE', 'services/api/src/server.mts', 9),
      missing('SMTP_USER', 'services/mailer/mailer.rb', 6),
      // Defined only in .env.test and never read: the newer env files count for UNUSED too.
      { kind: 'unused', var_name: 'TEST_ONLY_FLAG', file: 'services/api/.env.test', line: 1, env_file: 'services/api/.env.test' },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('scans .mjs, .cjs, .mts and .cts files', async () => {
    const files = new Set((await scanProject(FIXTURE)).references.map((r) => r.file));
    for (const file of ['scripts/release.mjs', 'services/api/src/boot.cjs', 'services/api/src/legacy.cts', 'services/api/src/server.mts']) {
      expect(files, file).toContain(file);
    }
  });

  it('reads .env.development, .env.production, .env.test and their .local variants as env files', async () => {
    const result = await scanProject(FIXTURE);
    expect(result.envScopes).toEqual([
      { scope: '', env_files: [] },
      { scope: 'services/api', env_files: ['.env.example', '.env.development.local', '.env.production', '.env.test'] },
      { scope: 'services/mailer', env_files: ['.env.example'] },
    ]);
  });

  it('lists every variable, optional when every reference has a default, and the no-env-file scope with no MISSING rows', async () => {
    const result = await scanProject(FIXTURE);
    expect(result.variables).toEqual([
      // Root: no env file anywhere, so these are listed (for the handoff and a starting .env.example) but never MISSING.
      v('DEPLOY_KEY', '', []),
      v('DEPLOY_REGION', '', [], true), // os.getenv("DEPLOY_REGION") or "eu"
      v('DEPLOY_TARGET', '', [], true), // os.getenv("DEPLOY_TARGET", "staging")
      v('RELEASE_CHANNEL', '', [], true), // process.env.RELEASE_CHANNEL ?? 'stable'
      v('RELEASE_TOKEN', '', []),
      v('API_KEY', 'services/api', ['.env.example']),
      v('CJS_ONLY', 'services/api', []),
      v('CTS_ONLY', 'services/api', []),
      v('DEV_TOKEN', 'services/api', ['.env.development.local']),
      v('GITHUB_CLIENT_SECRET', 'services/api', ['.env.example']), // an app's own GITHUB_ name still counts
      v('LOG_LEVEL', 'services/api', [], true), // process.env.LOG_LEVEL || 'info'
      v('MISSING_ONE', 'services/api', []),
      v('PORT', 'services/api', [], true), // process.env.PORT ?? 3000
      v('PROD_DB_URL', 'services/api', ['.env.production']),
      v('MAILER_REGION', 'services/mailer', []),
      v('SMTP_DEBUG', 'services/mailer', [], true), // ENV["SMTP_DEBUG"] || "false"
      v('SMTP_FROM', 'services/mailer', [], true), // ENV.fetch("SMTP_FROM") { … }
      v('SMTP_PORT', 'services/mailer', [], true), // ENV.fetch("SMTP_PORT", 587)
      v('SMTP_URL', 'services/mailer', ['.env.example']),
      v('SMTP_USER', 'services/mailer', []),
    ]);
    expect(result.findings.some((f) => f.file?.startsWith('scripts/'))).toBe(false);
  });

  it('skips platform and runtime names by default (in code and env files), and lists them', async () => {
    const result = await scanProject(FIXTURE);
    expect(result.defaultIgnored).toEqual(['CI', 'GITHUB_SHA', 'NODE_ENV', 'VERCEL_URL', 'npm_package_version']);
    const names = new Set([...result.variables.map((x) => x.var_name), ...result.findings.map((f) => f.var_name)]);
    for (const name of result.defaultIgnored) expect(names, name).not.toContain(name);
  });

  it('brings them back with defaultIgnore: false; --ignore still applies on top', async () => {
    const all = await scanProject(FIXTURE, { defaultIgnore: false });
    expect(all.defaultIgnored).toEqual([]);
    expect(all.variables).toContainEqual(v('VERCEL_URL', 'services/api', ['.env.production']));
    expect(all.variables).toContainEqual(v('npm_package_version', '', []));
    // Ignored by the user's own pattern: not reported as "skipped by default" either.
    const own = await scanProject(FIXTURE, { ignore: ['NODE_ENV'] });
    expect(own.defaultIgnored).toEqual(['CI', 'GITHUB_SHA', 'VERCEL_URL', 'npm_package_version']);
  });

  it('gives the same result from in-memory files (the GitHub App path)', async () => {
    const entries = await readdir(FIXTURE, { recursive: true, withFileTypes: true });
    const paths = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(FIXTURE.length).split('\\').join('/'));
    const files = new Map(await Promise.all(paths.map(async (p) => [p, await readFile(join(FIXTURE, p), 'utf8')] as const)));
    const fromTree = await scanFiles(files);
    const fromDir = await scanProject(FIXTURE);
    expect(fromTree.findings).toEqual(fromDir.findings);
    expect(fromTree.variables).toEqual(fromDir.variables);
    expect(fromTree.envScopes).toEqual(fromDir.envScopes);
  });
});

describe('DEFAULT_IGNORE', () => {
  const ignored = createNameFilter(DEFAULT_IGNORE);

  it('covers the runtime, npm, GitHub Actions and hosting platforms', () => {
    for (const name of ['NODE_ENV', 'CI', 'NEXT_RUNTIME', 'HOME', 'PATH', 'npm_package_version', 'npm_lifecycle_event', 'GITHUB_SHA', 'GITHUB_REF_NAME', 'GITHUB_WORKSPACE', 'RUNNER_OS', 'VERCEL', 'VERCEL_URL', 'VERCEL_ENV', 'NEXT_PUBLIC_VERCEL_URL', 'RAILWAY_ENVIRONMENT', 'RENDER', 'RENDER_EXTERNAL_URL', 'FLY_APP_NAME']) {
      expect(ignored(name), name).toBe(true);
    }
  });

  it("never hides an app's own config, including its own GITHUB_ names", () => {
    for (const name of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_TOKEN', 'PORT', 'DATABASE_URL', 'URL', 'NODE_OPTIONS', 'NPM_TOKEN', 'MY_VERCEL_URL']) {
      expect(ignored(name), name).toBe(false);
    }
  });
});

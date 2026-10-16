import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Logs never print tokens, webhook URLs, cookies or env values. Two layers, both pinned here:
 * every server process routes `console` through installConsoleRedaction() at startup
 * (packages/db/src/redact.ts, whose patterns test/redact.test.ts covers), and no source file hands
 * a raw error object to `console` (its own fields, such as a pg error's `detail`, can quote row
 * values; print the name and code, or the stack, instead).
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', 'playwright-report', 'test-results', 'fixtures', 'drizzle']);
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const isTestFile = (path: string) => /(?:^|\/)(?:test|e2e)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name)) {
      out.push(relative(ROOT, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return out;
}

/** `console.error('…', error)`: a bare error-ish identifier as an argument. */
const RAW_ERROR_ARGUMENT = /console\.(?:log|info|warn|error|debug|trace)\((?:[^;\n]*,\s*)?(?:error|err|e|reason|cause)\s*\)/;

describe('log redaction', () => {
  it('no source file passes a raw error object to console', () => {
    const offenders = sourceFiles(ROOT)
      .filter((path) => !isTestFile(path) && /^(?:apps|packages|scripts)\//.test(path))
      .filter((path) => RAW_ERROR_ARGUMENT.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the pattern catches the shapes it is meant to', () => {
    expect(RAW_ERROR_ARGUMENT.test("console.error('[worker] pg-boss error', error)")).toBe(true);
    expect(RAW_ERROR_ARGUMENT.test('console.warn(err)')).toBe(true);
    expect(RAW_ERROR_ARGUMENT.test('console.error(`[pg-boss] ${error.name}`)')).toBe(false);
  });

  it('both servers install the redacting console at startup', () => {
    const worker = readFileSync(join(ROOT, 'apps/worker/src/index.ts'), 'utf8');
    const web = readFileSync(join(ROOT, 'apps/web/src/instrumentation.ts'), 'utf8');
    for (const text of [worker, web]) expect(text).toMatch(/installConsoleRedaction\(\)/);
    // The worker installs it before anything can log: at module level, ahead of main().
    expect(worker.indexOf('installConsoleRedaction();')).toBeLessThan(worker.indexOf('async function main'));
  });
});

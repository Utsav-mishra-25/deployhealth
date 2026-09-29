import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every outbound HTTP request from deployhealth's servers must go through the guarded module
 * (SSRF-checked at connect time, bodies never read). This walks the whole repository and fails if
 * any other source file contains an HTTP client call or import.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const GUARDED_MODULE = 'apps/worker/src/guarded-http.ts';

/** Every allowed exception besides test files, with the reason it's safe. */
const ALLOWLIST: Record<string, string> = {
  [GUARDED_MODULE]: 'the guarded HTTP module itself',
  'packages/core/src/cli.ts':
    "the deployhealth-scan CLI runs in the user's CI, not on our servers, and posts only to the --url it is given (io.fetch)",
  'packages/core/src/scanner.ts': "matches Ruby's ENV.fetch in the code it scans; makes no requests",
};

const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ['fetch(', /\bfetch\(/],
  ['http.request(', /\bhttp\.request\(/],
  ['https.request(', /\bhttps\.request\(/],
  ['http(s).get(', /\bhttps?\.get\(/],
  ['axios', /axios/],
  ['undici', /undici/],
  ['got(', /\bgot\(/],
  ['node-fetch', /node-fetch/],
  // Imports catch aliased calls (`import { request } from 'node:https'`) the patterns above miss.
  ['node:http(s) import', /\bfrom\s+['"](?:node:)?https?['"]|require\(\s*['"](?:node:)?https?['"]\s*\)/],
  ['node:http2 import', /['"](?:node:)?http2['"]/],
];

/** Gitignored build outputs, skipped because their source is checked above. */
const GENERATED = new Set(['apps/web/public/deployhealth-scan.mjs']); // copy of the CLI bundle (cli.ts)

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', 'playwright-report', 'test-results', 'fixtures', 'drizzle']);
const SOURCE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const isTestFile = (path: string) => /(?:^|\/)(?:test|e2e)\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name)) {
      const path = relative(ROOT, join(dir, entry.name)).split(sep).join('/');
      if (!GENERATED.has(path)) out.push(path);
    }
  }
  return out;
}

const violations = (path: string) => {
  const text = readFileSync(join(ROOT, path), 'utf8');
  return FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
};

describe('outbound HTTP goes only through the guarded module', () => {
  const files = sourceFiles(ROOT);

  it('scans the whole repository (apps, packages, scripts and configs)', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toEqual(
      expect.arrayContaining([GUARDED_MODULE, 'apps/web/src/middleware.ts', 'apps/web/next.config.ts', 'packages/core/scripts/pack-npm.mjs']),
    );
  });

  it('finds no HTTP client call or import in any other non-test file', () => {
    const offenders = files
      .filter((path) => !isTestFile(path) && !(path in ALLOWLIST))
      .flatMap((path) => violations(path).map((label) => `${path}: ${label}`));
    expect(offenders).toEqual([]);
  });

  it('keeps the allowlist tight: every entry exists and still needs its exception', () => {
    for (const path of Object.keys(ALLOWLIST)) {
      expect(files, path).toContain(path);
      expect(violations(path), path).not.toEqual([]);
    }
  });

  it('would catch each forbidden form', () => {
    const samples = [
      'await fetch(url)',
      'globalThis.fetch(url)',
      'http.request(url)',
      'https.request(url, cb)',
      'https.get(url)',
      "import axios from 'axios'",
      "import { request } from 'undici'",
      'await got(url)',
      "import fetch from 'node-fetch'",
      "import { request } from 'node:https'",
      "import * as http from 'http'",
      "const h = require('https')",
      "import http2 from 'node:http2'",
    ];
    for (const sample of samples) expect(FORBIDDEN.some(([, p]) => p.test(sample)), sample).toBe(true);
    for (const safe of ["import { isIP } from 'node:net'", 'const url = new URL(x)', "import { createServer } from 'node:net'"]) {
      expect(FORBIDDEN.some(([, p]) => p.test(safe)), safe).toBe(false);
    }
  });
});

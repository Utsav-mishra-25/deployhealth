import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { CLI_BUNDLE_KB } from '../src/constants';
import { githubActionSnippet } from '../src/ingest';
import { LANGUAGES_SENTENCE } from '../src/languages';
import { CLI_VERSION } from '../src/version';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const NPM = fileURLToPath(new URL('../npm/', import.meta.url));
const BIN = `${NPM}dist/deployhealth-scan.mjs`;
const manifest = JSON.parse(readFileSync(`${NPM}package.json`, 'utf8'));

describe('the deployhealth-scan npm package', () => {
  it('is public, MIT, one bin, only dist and README, no dependencies, same version as the CLI', () => {
    expect(manifest).toMatchObject({
      name: 'deployhealth-scan',
      version: CLI_VERSION,
      license: 'MIT',
      type: 'module',
      bin: { 'deployhealth-scan': 'dist/deployhealth-scan.mjs' },
      files: ['dist', 'README.md'],
      publishConfig: { access: 'public' },
    });
    expect(manifest.private).toBeUndefined();
    expect(manifest.dependencies).toBeUndefined();
    // Provenance ties the package to this repository, so the URL must be exactly the repo's.
    expect(manifest.repository.url).toBe('git+https://github.com/Utsav-mishra-25/deployhealth.git');
    expect(readFileSync(`${NPM}README.md`, 'utf8')).toContain(`npx deployhealth-scan@${CLI_VERSION} `);
    expect(readFileSync(`${NPM}README.md`, 'utf8').split('\n')).toContain(LANGUAGES_SENTENCE);
  });

  it("README's workflow is exactly the snippet the settings page generates", () => {
    const readme = readFileSync(`${NPM}README.md`, 'utf8');
    const yaml = /```yaml\n([\s\S]*?)```/.exec(readme)?.[1];
    const snippet = githubActionSnippet({ appUrl: 'https://deployhealth.dev', version: CLI_VERSION });
    expect(yaml).toBe(snippet.slice(snippet.indexOf('\n') + 1)); // minus the "# .github/workflows/…" line
  });

  describe('after build:npm', () => {
    beforeAll(() => {
      execFileSync('pnpm', ['run', 'build:npm'], { cwd: CORE, stdio: 'pipe' });
    }, 60_000);

    it('packs exactly the bundle, the README, the MIT license and the manifest', () => {
      const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: NPM, encoding: 'utf8' }));
      expect(pack.files.map((f: { path: string }) => f.path).sort()).toEqual(['LICENSE', 'README.md', 'dist/deployhealth-scan.mjs', 'package.json']);
      expect(readFileSync(`${NPM}LICENSE`, 'utf8')).toMatch(/^MIT License\n\nCopyright \(c\) 2026 Utsav Mishra/);
    });

    it('is an executable that prints the package version', () => {
      expect(readFileSync(BIN, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(statSync(BIN).mode & 0o111).not.toBe(0);
      expect(execFileSync(BIN, ['--version'], { encoding: 'utf8' })).toBe(`${CLI_VERSION}\n`);
    });

    it('is as small as the landing page says (CLI_BUNDLE_KB, rounded)', () => {
      expect(Math.round(statSync(BIN).size / 1024)).toBe(CLI_BUNDLE_KB);
    });
  });
});

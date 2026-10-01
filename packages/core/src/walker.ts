import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitignoreMatcher } from './gitignore';
import { isTestFileName, TEST_DIRS } from './test-paths';
import type { Warning } from './types';
import { isVendoredFileName, VENDORED_DIRS } from './vendored';

/** Directory names that are never descended into, at any depth: `.git` and vendored code (vendored.ts). */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set(['.git', ...VENDORED_DIRS]);

export interface WalkOptions {
  /** Return true for files to list. Receives the POSIX path relative to the root and the base name. */
  include: (relPath: string, name: string) => boolean;
  /** Extra gitignore-style patterns applied at the root, e.g. `packages/core/test/**`. */
  exclude?: readonly string[];
  /**
   * Files (by base name) listed even when a .gitignore matches them. Used for `.env` files,
   * which are almost always gitignored but are exactly what the scanner needs to read.
   * `exclude` still applies to them.
   */
  keepIgnored?: (name: string) => boolean;
  skipDirs?: ReadonlySet<string>;
  respectGitignore?: boolean;
  /**
   * List test files and everything under test directories (test-paths.ts) in `testFiles`
   * instead of `files`.
   */
  skipTests?: boolean;
}

export interface WalkResult {
  /** POSIX paths relative to the root, sorted. */
  files: string[];
  warnings: Warning[];
  /** Files `include` accepted that are tests or fixtures (with `skipTests`), sorted. */
  testFiles: string[];
  /**
   * Vendored code that was skipped though nothing ignores it, sorted: directories holding files
   * `include` accepts (`.yarn/`, a committed `dist/`; once each, with a trailing slash) and
   * generated files (`.pnp.cjs`, `*.min.js`). Never anything inside a test directory.
   */
  vendored: string[];
}

/**
 * Recursively list files under `root`. Honors .gitignore files at every level plus `exclude`,
 * never follows symlinks, and always skips `skipDirs`. Ignored directories are never entered.
 */
export async function walk(root: string, options: WalkOptions): Promise<WalkResult> {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const respectGitignore = options.respectGitignore ?? true;
  const files: string[] = [];
  const warnings: Warning[] = [];
  const testFiles: string[] = [];
  const vendored: string[] = [];

  const excluded = GitignoreMatcher.empty().extend('', (options.exclude ?? []).join('\n'));

  async function visit(relDir: string, matcher: GitignoreMatcher, inTests: boolean): Promise<void> {
    const absDir = relDir === '' ? root : join(root, relDir);
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (error) {
      warnings.push({ file: relDir || '.', message: `cannot read directory: ${(error as Error).message}` });
      return;
    }

    if (respectGitignore && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      matcher = matcher.extend(relDir, await readFile(join(absDir, '.gitignore'), 'utf8'));
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (excluded.ignores(relPath, true) || matcher.ignores(relPath, true)) continue;
        if (skipDirs.has(entry.name)) {
          if (VENDORED_DIRS.has(entry.name) && !inTests && (await holdsAny(relPath))) vendored.push(`${relPath}/`);
          continue;
        }
        await visit(relPath, matcher, inTests || (options.skipTests === true && TEST_DIRS.has(entry.name)));
      } else if (entry.isFile()) {
        if (!options.include(relPath, entry.name) || excluded.ignores(relPath, false)) continue;
        if (matcher.ignores(relPath, false) && !options.keepIgnored?.(entry.name)) continue;
        if (isVendoredFileName(entry.name)) {
          if (!inTests) vendored.push(relPath);
        } else if (options.skipTests && (inTests || isTestFileName(entry.name))) testFiles.push(relPath);
        else files.push(relPath);
      }
    }
  }

  /** Whether a skipped directory holds any file `include` accepts (stops at the first), so empty or asset-only ones aren't reported. */
  async function holdsAny(relDir: string): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(join(root, relDir), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const relPath = `${relDir}/${entry.name}`;
      if (entry.isFile() && options.include(relPath, entry.name)) return true;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && (await holdsAny(`${relDir}/${entry.name}`))) return true;
    }
    return false;
  }

  await visit('', GitignoreMatcher.empty(), false);
  files.sort();
  testFiles.sort();
  vendored.sort();
  return { files, warnings, testFiles, vendored };
}

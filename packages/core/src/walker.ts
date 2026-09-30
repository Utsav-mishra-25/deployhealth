import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitignoreMatcher } from './gitignore';
import { isTestFileName, TEST_DIRS } from './test-paths';
import type { Warning } from './types';

/** Directory names that are never descended into, at any depth. */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  'venv',
  '.venv',
]);

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
        if (skipDirs.has(entry.name) || excluded.ignores(relPath, true) || matcher.ignores(relPath, true)) continue;
        await visit(relPath, matcher, inTests || (options.skipTests === true && TEST_DIRS.has(entry.name)));
      } else if (entry.isFile()) {
        if (!options.include(relPath, entry.name) || excluded.ignores(relPath, false)) continue;
        if (matcher.ignores(relPath, false) && !options.keepIgnored?.(entry.name)) continue;
        if (options.skipTests && (inTests || isTestFileName(entry.name))) testFiles.push(relPath);
        else files.push(relPath);
      }
    }
  }

  await visit('', GitignoreMatcher.empty(), false);
  files.sort();
  testFiles.sort();
  return { files, warnings, testFiles };
}

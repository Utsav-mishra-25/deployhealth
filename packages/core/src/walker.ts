import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitignoreMatcher } from './gitignore';
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
  skipDirs?: ReadonlySet<string>;
  respectGitignore?: boolean;
}

export interface WalkResult {
  /** POSIX paths relative to the root, sorted. */
  files: string[];
  warnings: Warning[];
}

/**
 * Recursively list files under `root`. Honors .gitignore files at every level plus `exclude`,
 * never follows symlinks, and always skips `skipDirs`.
 */
export async function walk(root: string, options: WalkOptions): Promise<WalkResult> {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const respectGitignore = options.respectGitignore ?? true;
  const files: string[] = [];
  const warnings: Warning[] = [];

  let rootMatcher = GitignoreMatcher.empty();
  if (options.exclude?.length) rootMatcher = rootMatcher.extend('', options.exclude.join('\n'));

  async function visit(relDir: string, matcher: GitignoreMatcher): Promise<void> {
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
        if (skipDirs.has(entry.name) || matcher.ignores(relPath, true)) continue;
        await visit(relPath, matcher);
      } else if (entry.isFile()) {
        if (!options.include(relPath, entry.name) || matcher.ignores(relPath, false)) continue;
        files.push(relPath);
      }
    }
  }

  await visit('', rootMatcher);
  files.sort();
  return { files, warnings };
}

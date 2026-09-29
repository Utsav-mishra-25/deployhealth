import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseEnv } from './env-parser';
import { analyzeScope, compareFindings, requiredVariables, summarize, type ScopeEnvFile } from './findings';
import { createNameFilter } from './glob';
import { languageForFile, SCANNED_EXTENSIONS, scanSource } from './scanner';
import { ENV_FILE_BASENAMES, type FindingCounts, type FindingRow, type Reference, type RequiredVariable, type Warning } from './types';
import { walk } from './walker';

/** Env files read in every scope. Other names (e.g. `.env.production`) are ignored. */
export const ENV_FILE_NAMES: ReadonlySet<string> = new Set(ENV_FILE_BASENAMES);

export interface ScanOptions {
  /** Variable-name globs to skip in every section, e.g. `NODE_ENV` or `NEXT_PUBLIC_*`. */
  ignore?: readonly string[];
  /** Gitignore-style path patterns to leave out of the walk, e.g. `packages/core/test/**`. */
  exclude?: readonly string[];
}

export interface ScanResult {
  findings: FindingRow[];
  /** Every referenced variable per scope, with the env files that define it (names only). */
  variables: RequiredVariable[];
  counts: FindingCounts;
  /** Directories (relative, '' = root) that own env files, i.e. the scopes that were checked. */
  scopes: string[];
  sourceFiles: number;
  envFiles: string[];
  warnings: Warning[];
}

/**
 * Scan a project, monorepo-aware.
 *
 * Every directory that contains an env file is a *scope*. Each source file is checked against
 * the env files of its nearest enclosing scope (its own directory or the closest ancestor), so
 * `apps/web/src/x.ts` is compared with `apps/web/.env.example`, not with some other package's.
 * Files with no enclosing scope fall into the root scope, which has no env files if the root
 * has none, so everything they reference is MISSING.
 */
export async function scanProject(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const { files, warnings } = await walk(root, {
    include: (relPath, name) => ENV_FILE_NAMES.has(name) || SCANNED_EXTENSIONS.has(posix.extname(relPath).toLowerCase()),
    exclude: options.exclude,
    keepIgnored: (name) => ENV_FILE_NAMES.has(name),
  });

  const envFiles: ScopeEnvFile[] = [];
  const sourceFiles: string[] = [];
  for (const file of files) {
    const name = posix.basename(file);
    if (!ENV_FILE_NAMES.has(name)) {
      sourceFiles.push(file);
      continue;
    }
    const { entries, invalid } = parseEnv(await readFile(join(root, file), 'utf8'));
    for (const { line } of invalid) warnings.push({ file, line, message: 'ignored a line that is not KEY=value' });
    envFiles.push({ path: file, name, entries });
  }

  const scopeDirs = new Set(envFiles.map((f) => dirOf(f.path)));
  const referencesByScope = new Map<string, Reference[]>();
  for (const file of sourceFiles) {
    const language = languageForFile(file);
    if (!language) continue;
    const refs = scanSource(await readFile(join(root, file), 'utf8'), language, file);
    if (refs.length === 0) continue;
    const scope = nearestScope(dirOf(file), scopeDirs);
    referencesByScope.set(scope, [...(referencesByScope.get(scope) ?? []), ...refs]);
  }

  const isIgnored = createNameFilter(options.ignore ?? []);
  const scopes = [...new Set([...scopeDirs, ...referencesByScope.keys()])].sort();
  const findings = scopes
    .flatMap((scope) =>
      analyzeScope({
        references: referencesByScope.get(scope) ?? [],
        envFiles: envFiles.filter((f) => dirOf(f.path) === scope),
        isIgnored,
      }),
    )
    .sort(compareFindings);
  const variables = scopes.flatMap((scope) =>
    requiredVariables({
      scope,
      references: referencesByScope.get(scope) ?? [],
      envFiles: envFiles.filter((f) => dirOf(f.path) === scope),
      isIgnored,
    }),
  );

  return {
    findings,
    variables,
    counts: summarize(findings),
    scopes,
    sourceFiles: sourceFiles.length,
    envFiles: envFiles.map((f) => f.path),
    warnings,
  };
}

function dirOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
}

/** The directory itself if it is a scope, else the closest ancestor that is; '' (root) otherwise. */
function nearestScope(dir: string, scopes: ReadonlySet<string>): string {
  for (let current = dir; current !== ''; current = dirOf(current)) {
    if (scopes.has(current)) return current;
  }
  return '';
}

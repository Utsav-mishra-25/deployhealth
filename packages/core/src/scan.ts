import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { parseEnv } from './env-parser';
import { analyzeScope, compareFindings, requiredVariables, summarize, type ScopeEnvFile } from './findings';
import { createNameFilter } from './glob';
import { languageForFile, SCANNED_EXTENSIONS, scanSource } from './scanner';
import { ENV_FILE_BASENAMES, type FindingCounts, type FindingRow, type Reference, type RequiredVariable, type Warning } from './types';
import { GitignoreMatcher } from './gitignore';
import { DEFAULT_SKIP_DIRS, walk } from './walker';

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
  /** Every reference found, with the scope it was checked against. */
  references: Array<Reference & { scope: string }>;
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
    include: isScannable,
    exclude: options.exclude,
    keepIgnored: (name) => ENV_FILE_NAMES.has(name),
  });
  return analyzeFiles(files, (file) => readFile(join(root, file), 'utf8'), warnings, options);
}

/**
 * `scanProject` over files already in memory (e.g. blobs from a git tree), keyed by POSIX path
 * relative to the repo root. Pick the paths with `selectTreeFiles` so the rules are the same.
 */
export async function scanFiles(files: ReadonlyMap<string, string>, options: Pick<ScanOptions, 'ignore'> = {}): Promise<ScanResult> {
  const paths = [...files.keys()].filter((path) => isScannable(path, posix.basename(path))).sort();
  return analyzeFiles(paths, async (path) => files.get(path)!, [], options);
}

/** Env files and source files in a scanned language. */
function isScannable(relPath: string, name: string): boolean {
  return ENV_FILE_NAMES.has(name) || SCANNED_EXTENSIONS.has(posix.extname(relPath).toLowerCase());
}

async function analyzeFiles(
  files: readonly string[],
  read: (file: string) => Promise<string>,
  warnings: Warning[],
  options: ScanOptions,
): Promise<ScanResult> {
  const envFiles: ScopeEnvFile[] = [];
  const sourceFiles: string[] = [];
  for (const file of files) {
    const name = posix.basename(file);
    if (!ENV_FILE_NAMES.has(name)) {
      sourceFiles.push(file);
      continue;
    }
    const { entries, invalid } = parseEnv(await read(file));
    for (const { line } of invalid) warnings.push({ file, line, message: 'ignored a line that is not KEY=value' });
    envFiles.push({ path: file, name, entries });
  }

  const scopeDirs = new Set(envFiles.map((f) => dirOf(f.path)));
  const referencesByScope = new Map<string, Reference[]>();
  for (const file of sourceFiles) {
    const language = languageForFile(file);
    if (!language) continue;
    const refs = scanSource(await read(file), language, file);
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
  const references = scopes
    .flatMap((scope) => (referencesByScope.get(scope) ?? []).filter((r) => !isIgnored(r.name)).map((r) => ({ ...r, scope })))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);

  return {
    findings,
    references,
    variables,
    counts: summarize(findings),
    scopes,
    sourceFiles: sourceFiles.length,
    envFiles: envFiles.map((f) => f.path),
    warnings,
  };
}

/**
 * The files `scanProject` would read, chosen from a git tree's blob paths instead of a directory:
 * the same skipped directories, nested `.gitignore` files (read top-down through `readGitignore`,
 * so ones inside ignored directories are never read) and env files kept even when ignored.
 * Returns the paths to fetch, sorted.
 */
export async function selectTreeFiles(
  paths: readonly string[],
  readGitignore: (path: string) => Promise<string>,
  { skipDirs = DEFAULT_SKIP_DIRS }: { skipDirs?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const gitignores = new Set(paths.filter((p) => posix.basename(p) === '.gitignore'));
  const matchers = new Map<string, GitignoreMatcher | null>(); // null: the directory is skipped or ignored

  async function matcherFor(dir: string): Promise<GitignoreMatcher | null> {
    const known = matchers.get(dir);
    if (known !== undefined) return known;
    let matcher: GitignoreMatcher | null;
    if (dir === '') {
      matcher = GitignoreMatcher.empty();
    } else {
      const parent = await matcherFor(dirOf(dir));
      matcher = parent && !skipDirs.has(posix.basename(dir)) && !parent.ignores(dir, true) ? parent : null;
    }
    const ignoreFile = dir === '' ? '.gitignore' : `${dir}/.gitignore`;
    if (matcher && gitignores.has(ignoreFile)) matcher = matcher.extend(dir, await readGitignore(ignoreFile));
    matchers.set(dir, matcher);
    return matcher;
  }

  const selected: string[] = [];
  for (const path of [...paths].sort()) {
    const name = posix.basename(path);
    if (!isScannable(path, name)) continue;
    const matcher = await matcherFor(dirOf(path));
    if (!matcher) continue;
    if (matcher.ignores(path, false) && !ENV_FILE_NAMES.has(name)) continue;
    selected.push(path);
  }
  return selected;
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

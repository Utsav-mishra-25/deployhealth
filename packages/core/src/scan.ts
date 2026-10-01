import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { DEFAULT_IGNORE } from './default-ignore';
import { parseEnv } from './env-parser';
import { analyzeScope, compareFindings, requiredVariables, summarize, type ScopeEnvFile } from './findings';
import { createNameFilter } from './glob';
import { languageForFile, SCANNED_EXTENSIONS, scanSource } from './scanner';
import { isEnvFileName, MAX_ENV_FILES_PER_SCOPE, sortEnvFileNames } from './env-files';
import {
  type EnvScope,
  type FindingCounts,
  type FindingRow,
  type Reference,
  type RequiredVariable,
  type Warning,
} from './types';
import { GitignoreMatcher } from './gitignore';
import { isTestPath } from './test-paths';
import { DEFAULT_SKIP_DIRS, walk } from './walker';

export interface ScanOptions {
  /** Variable-name globs to skip in every section, e.g. `NEXT_PUBLIC_*`. */
  ignore?: readonly string[];
  /** Also skip DEFAULT_IGNORE, the names the platform or runtime provides. Default true. */
  defaultIgnore?: boolean;
  /** Also scan test files and test/fixture directories (test-paths.ts). Default false. */
  includeTests?: boolean;
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
  /** Every scope with the env files it has; one with none gets no MISSING rows. */
  envScopes: EnvScope[];
  /** Names found (in code or env files) that only DEFAULT_IGNORE skipped, sorted. */
  defaultIgnored: string[];
  /**
   * Files treated as tests or fixtures (0 with `includeTests`): never reported, and their env
   * files never make scopes. Their source is read only so a variable only tests use isn't UNUSED.
   */
  testFilesSkipped: number;
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
  const { files, warnings, testFiles } = await walk(root, {
    include: isScannable,
    exclude: options.exclude,
    keepIgnored: isEnvFileName,
    skipTests: !options.includeTests,
  });
  return analyzeFiles(files, (file) => readFile(join(root, file), 'utf8'), warnings, options, testFiles);
}

/**
 * `scanProject` over files already in memory (e.g. blobs from a git tree), keyed by POSIX path
 * relative to the repo root. Pick the paths with `selectTreeFiles` so the rules are the same.
 */
export async function scanFiles(
  files: ReadonlyMap<string, string>,
  options: Pick<ScanOptions, 'ignore' | 'defaultIgnore' | 'includeTests'> = {},
): Promise<ScanResult> {
  const scannable = [...files.keys()].filter((path) => isScannable(path, posix.basename(path))).sort();
  const tests = new Set(options.includeTests ? [] : scannable.filter((path) => isTestPath(path)));
  const paths = scannable.filter((path) => !tests.has(path));
  return analyzeFiles(paths, async (path) => files.get(path)!, [], options, [...tests]);
}

/** Env files (env-files.ts; other names such as `.env.staging` are ignored) and source files in a scanned language. */
function isScannable(relPath: string, name: string): boolean {
  return isEnvFileName(name) || SCANNED_EXTENSIONS.has(posix.extname(relPath).toLowerCase());
}

async function analyzeFiles(
  files: readonly string[],
  read: (file: string) => Promise<string>,
  warnings: Warning[],
  options: ScanOptions,
  testFiles: readonly string[],
): Promise<ScanResult> {
  const envFiles: ScopeEnvFile[] = [];
  const sourceFiles: string[] = [];
  for (const file of files) {
    const name = posix.basename(file);
    if (!isEnvFileName(name)) {
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

  // Test files: read only for the names they use (UNUSED), never reported. Their env files are left out.
  const usedByTestsByScope = new Map<string, Set<string>>();
  for (const file of testFiles) {
    const language = languageForFile(file);
    if (!language) continue;
    const scope = nearestScope(dirOf(file), scopeDirs);
    const names = usedByTestsByScope.get(scope) ?? new Set<string>();
    for (const ref of scanSource(await read(file), language, file)) names.add(ref.name);
    usedByTestsByScope.set(scope, names);
  }

  const byUser = createNameFilter(options.ignore ?? []);
  const byDefault = createNameFilter(options.defaultIgnore === false ? [] : DEFAULT_IGNORE);
  const isIgnored = (name: string) => byUser(name) || byDefault(name);
  const seen = [...referencesByScope.values()].flat().map((r) => r.name).concat(envFiles.flatMap((f) => f.entries.map((e) => e.key)));
  const defaultIgnored = [...new Set(seen.filter((name) => byDefault(name) && !byUser(name)))].sort();

  const scopes = [...new Set([...scopeDirs, ...referencesByScope.keys()])].sort();
  const envScopes = scopes.map((scope) => {
    const names = sortEnvFileNames(envFiles.filter((f) => dirOf(f.path) === scope).map((f) => f.name));
    if (names.length > MAX_ENV_FILES_PER_SCOPE) {
      warnings.push({ file: scope || '.', message: `${names.length} env files; only the first ${MAX_ENV_FILES_PER_SCOPE} are reported` });
    }
    return { scope, env_files: names.slice(0, MAX_ENV_FILES_PER_SCOPE) };
  });
  const findings = scopes
    .flatMap((scope) =>
      analyzeScope({
        references: referencesByScope.get(scope) ?? [],
        envFiles: envFiles.filter((f) => dirOf(f.path) === scope),
        isIgnored,
        usedByTests: usedByTestsByScope.get(scope),
      }),
    )
    .sort(compareFindings);
  const variables = scopes.flatMap((scope) =>
    requiredVariables({
      scope,
      references: referencesByScope.get(scope) ?? [],
      envFiles: envFiles.filter((f) => dirOf(f.path) === scope),
      isIgnored,
    }).map((v) => ({ ...v, defined_in: v.defined_in.slice(0, MAX_ENV_FILES_PER_SCOPE) })),
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
    envScopes,
    defaultIgnored,
    testFilesSkipped: testFiles.length,
    sourceFiles: sourceFiles.length,
    envFiles: envFiles.map((f) => f.path),
    warnings,
  };
}

/**
 * The files `scanProject` would read, chosen from a git tree's blob paths instead of a directory:
 * the same skipped directories, nested `.gitignore` files (read top-down through `readGitignore`,
 * so ones inside ignored directories are never read), env files kept even when ignored, and test
 * files and test/fixture directories left out unless `includeTests` (so they're never fetched).
 * Returns the paths to fetch, sorted.
 */
export async function selectTreeFiles(
  paths: readonly string[],
  readGitignore: (path: string) => Promise<string>,
  { skipDirs = DEFAULT_SKIP_DIRS, includeTests = false }: { skipDirs?: ReadonlySet<string>; includeTests?: boolean } = {},
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
    if (!isScannable(path, name) || (!includeTests && isTestPath(path))) continue;
    const matcher = await matcherFor(dirOf(path));
    if (!matcher) continue;
    if (matcher.ignores(path, false) && !isEnvFileName(name)) continue;
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

import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { composeVariableNames, isComposeFileName } from './compose';
import { DEFAULT_IGNORE } from './default-ignore';
import { parseEnv } from './env-parser';
import { analyzeScope, compareFindings, requiredVariables, summarize, type ScopeEnvFile } from './findings';
import { createNameFilter } from './glob';
import { inContextualSkipDir, treeMarkers, type TreeMarkers } from './build-dirs';
import { LARAVEL_FRAMEWORK_NAMES, LARAVEL_MARKER } from './laravel';
import { languageForFile, SCANNED_EXTENSIONS, scanSource, usedOnlyNames } from './scanner';
import { isSymfonyConfigPath, scanSymfonyConfig } from './symfony';
import { isDeclarationFile, isEnvFileName, MAX_ENV_FILES_PER_SCOPE, sortEnvFileNames } from './env-files';
import {
  type EnvScope,
  type FindingCounts,
  type FindingRow,
  type Reference,
  type RequiredVariable,
  type Warning,
} from './types';
import { isTestPath } from './test-paths';
import { isVendoredFileName, MAX_SOURCE_FILE_BYTES } from './vendored';
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
  /**
   * Vendored and generated code skipped though nothing ignores it (vendored.ts): directories once
   * each, with a trailing slash, and files such as `.pnp.cjs` or `app.min.js`. Directory scans
   * only; `scanFiles` gets paths `selectTreeFiles` already chose, so its list is empty.
   */
  vendoredSkipped: string[];
  /** Source files over MAX_SOURCE_FILE_BYTES (bundles, not code people wrote), never read. */
  tooLargeSkipped: string[];
  /**
   * Source files read, in a language the scanner reads (languages.ts), tests and oversized files
   * aside. 0 means the scan can't check this directory: it reports no UNUSED rows then.
   */
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
  const { files, warnings, testFiles, vendored } = await walk(root, {
    include: isScannable,
    exclude: options.exclude,
    keepIgnored: isEnvFileName,
    skipTests: !options.includeTests,
  });
  const source = {
    read: (file: string) => readFile(join(root, file), 'utf8'),
    size: async (file: string) => (await stat(join(root, file))).size,
  };
  return analyzeFiles(files, source, warnings, options, testFiles, vendored);
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
  const source = { read: async (path: string) => files.get(path)!, size: async (path: string) => Buffer.byteLength(files.get(path)!) };
  return analyzeFiles(paths, source, [], options, [...tests], []);
}

/**
 * Env files (env-files.ts; other names such as `.env.staging` are ignored), source files in a
 * scanned language, Compose files (compose.ts), Symfony config YAML (symfony.ts), and Laravel's
 * `artisan`, whose content is never read: it only marks its scope as a Laravel app.
 */
function isScannable(relPath: string, name: string): boolean {
  return (
    isEnvFileName(name) ||
    isComposeFileName(name) ||
    name === LARAVEL_MARKER ||
    isSymfonyConfigPath(relPath) ||
    SCANNED_EXTENSIONS.has(posix.extname(relPath).toLowerCase())
  );
}

const UNTERMINATED = {
  quote: 'a quote that never closes: the rest of the file was read as this value',
  block: 'a -----BEGIN block with no -----END line: the rest of the file was skipped',
} as const;

interface Source {
  read: (file: string) => Promise<string>;
  /** Size in bytes, checked before a source file is read. */
  size: (file: string) => Promise<number>;
}

async function analyzeFiles(
  files: readonly string[],
  { read, size }: Source,
  warnings: Warning[],
  options: ScanOptions,
  testFiles: readonly string[],
  vendoredSkipped: string[],
): Promise<ScanResult> {
  const envFiles: ScopeEnvFile[] = [];
  const sourceFiles: string[] = [];
  const composeFiles: string[] = [];
  const configFiles: string[] = [];
  const laravelDirs: string[] = [];
  const tooLargeSkipped: string[] = [];
  for (const file of files) {
    const name = posix.basename(file);
    if (name === LARAVEL_MARKER) {
      laravelDirs.push(dirOf(file));
      continue;
    }
    if (!isEnvFileName(name)) {
      if ((await size(file)) > MAX_SOURCE_FILE_BYTES) tooLargeSkipped.push(file);
      else if (isComposeFileName(name)) composeFiles.push(file);
      else if (languageForFile(file)) sourceFiles.push(file);
      else configFiles.push(file);
      continue;
    }
    const { entries, commented, invalid, unterminated } = parseEnv(await read(file));
    for (const { line } of invalid) warnings.push({ file, line, message: 'ignored a line that is not KEY=value' });
    if (unterminated) warnings.push({ file, line: unterminated.line, message: UNTERMINATED[unterminated.kind] });
    envFiles.push({ path: file, name, entries, commented: isDeclarationFile(name) ? commented : [] });
  }

  const scopeDirs = new Set(envFiles.map((f) => dirOf(f.path)));
  // Names read outside the scanned code: by test files (never reported; their env files are left
  // out), by Compose interpolation, by PHP's $_SERVER, and by Laravel's framework in a scope with
  // `artisan` (never MISSING). All of them only keep a variable from being UNUSED.
  const usedOutsideCode = new Map<string, Set<string>>();
  const markUsed = (file: string, names: Iterable<string>) => {
    const scope = nearestScope(dirOf(file), scopeDirs);
    let used = usedOutsideCode.get(scope);
    if (!used) usedOutsideCode.set(scope, (used = new Set()));
    for (const name of names) used.add(name);
  };

  const referencesByScope = new Map<string, Reference[]>();
  const addReferences = (file: string, refs: Reference[]) => {
    if (refs.length === 0) return;
    const scope = nearestScope(dirOf(file), scopeDirs);
    const list = referencesByScope.get(scope);
    if (list) for (const ref of refs) list.push(ref);
    else referencesByScope.set(scope, refs);
  };
  for (const file of sourceFiles) {
    const language = languageForFile(file)!;
    const text = await read(file);
    addReferences(file, scanSource(text, language, file));
    markUsed(file, usedOnlyNames(text, language));
  }
  // Symfony config YAML: references like code, but not source files (it alone can't be checked).
  for (const file of configFiles) addReferences(file, scanSymfonyConfig(await read(file), file));

  for (const file of testFiles) {
    const language = languageForFile(file);
    if (!language || (await size(file)) > MAX_SOURCE_FILE_BYTES) continue;
    const text = await read(file);
    markUsed(file, scanSource(text, language, file).map((ref) => ref.name));
    markUsed(file, usedOnlyNames(text, language));
  }
  for (const file of composeFiles) markUsed(file, composeVariableNames(await read(file)));
  for (const dir of laravelDirs) markUsed(`${dir ? `${dir}/` : ''}${LARAVEL_MARKER}`, LARAVEL_FRAMEWORK_NAMES);

  const byUser = createNameFilter(options.ignore ?? []);
  const byDefault = createNameFilter(options.defaultIgnore === false ? [] : DEFAULT_IGNORE);
  const isIgnored = (name: string) => byUser(name) || byDefault(name);
  const seen = new Set<string>();
  for (const refs of referencesByScope.values()) for (const ref of refs) seen.add(ref.name);
  for (const f of envFiles) for (const e of f.entries) seen.add(e.key);
  const defaultIgnored = [...seen].filter((name) => byDefault(name) && !byUser(name)).sort();

  const envFilesByScope = new Map<string, ScopeEnvFile[]>();
  for (const f of envFiles) {
    const scope = dirOf(f.path);
    const list = envFilesByScope.get(scope);
    if (list) list.push(f);
    else envFilesByScope.set(scope, [f]);
  }
  const envFilesOf = (scope: string) => envFilesByScope.get(scope) ?? [];

  const scopes = [...new Set([...scopeDirs, ...referencesByScope.keys()])].sort();
  const envScopes = scopes.map((scope) => {
    const names = sortEnvFileNames(envFilesOf(scope).map((f) => f.name));
    if (names.length > MAX_ENV_FILES_PER_SCOPE) {
      warnings.push({ file: scope || '.', message: `${names.length} env files; only the first ${MAX_ENV_FILES_PER_SCOPE} are reported` });
    }
    return { scope, env_files: names.slice(0, MAX_ENV_FILES_PER_SCOPE) };
  });
  const findings = scopes
    .flatMap((scope) =>
      analyzeScope({
        references: referencesByScope.get(scope) ?? [],
        envFiles: envFilesOf(scope),
        isIgnored,
        usedOutsideCode: usedOutsideCode.get(scope),
      }),
    )
    // With no source file in a language the scanner reads, nothing was read that could use a
    // variable, so "defined but never used" would be wrong: no UNUSED rows (MISMATCH stays).
    .filter((f) => sourceFiles.length > 0 || f.kind !== 'unused')
    .sort(compareFindings);
  const variables = scopes.flatMap((scope) =>
    requiredVariables({
      scope,
      references: referencesByScope.get(scope) ?? [],
      envFiles: envFilesOf(scope),
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
    vendoredSkipped,
    tooLargeSkipped,
    sourceFiles: sourceFiles.length,
    envFiles: envFiles.map((f) => f.path),
    warnings,
  };
}

/**
 * The files `scanProject` would read, chosen from a git tree's blob paths instead of a directory:
 * the same skipped directories, env files, test files and test/fixture directories left out
 * unless `includeTests`, and vendored code (vendored.ts: its directories, generated file names,
 * and, given `sizes`, source files over MAX_SOURCE_FILE_BYTES), so none of those are ever
 * fetched. Unlike a directory walk, `.gitignore` files are not applied: git never ignores a file
 * it tracks, so every path in the tree is committed code. Returns the paths to fetch, sorted.
 */
export function selectTreeFiles(
  paths: readonly string[],
  {
    skipDirs = DEFAULT_SKIP_DIRS,
    includeTests = false,
    sizes,
  }: { skipDirs?: ReadonlySet<string>; includeTests?: boolean; sizes?: ReadonlyMap<string, number> } = {},
): string[] {
  const selected: string[] = [];
  const markers = treeMarkers(paths);
  for (const path of paths) {
    const name = posix.basename(path);
    if (!isScannable(path, name) || !passesTreeRules(path, { skipDirs, includeTests, markers })) continue;
    if (!isEnvFileName(name) && (sizes?.get(path) ?? 0) > MAX_SOURCE_FILE_BYTES) continue;
    selected.push(path);
  }
  return selected.sort();
}

/**
 * The rules `selectTreeFiles` applies whatever the file type: not in a skipped (vendored)
 * directory or build output known by its context (build-dirs.ts; pass the tree's `treeMarkers`
 * for the rules that depend on a marker file such as `artisan`), not a generated file name, not
 * a test file or under a test directory. Used to count files the scanner doesn't read with the
 * same rules, so `node_modules/**` never counts.
 */
export function passesTreeRules(
  path: string,
  {
    skipDirs = DEFAULT_SKIP_DIRS,
    includeTests = false,
    markers = NO_MARKERS,
  }: { skipDirs?: ReadonlySet<string>; includeTests?: boolean; markers?: TreeMarkers } = {},
): boolean {
  return (
    !isVendoredFileName(posix.basename(path)) &&
    (includeTests || !isTestPath(path)) &&
    !inSkippedDir(path, skipDirs) &&
    !inContextualSkipDir(path, markers)
  );
}

const NO_MARKERS: TreeMarkers = treeMarkers([]);

/** Whether any directory on the path is one `walk` never enters. */
function inSkippedDir(path: string, skipDirs: ReadonlySet<string>): boolean {
  let start = 0;
  for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', start)) {
    if (skipDirs.has(path.slice(start, slash))) return true;
    start = slash + 1;
  }
  return false;
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

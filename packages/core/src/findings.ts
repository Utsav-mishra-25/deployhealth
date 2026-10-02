import type { EnvEntry } from './env-parser';
import { sortEnvFileNames, type EnvFileName } from './env-files';
import { type EnvScope, type FindingCounts, type FindingKind, type FindingRow, type Reference, type RequiredVariable } from './types';

/** An env file that belongs to a scope. `path` is relative to the scan root. */
export interface ScopeEnvFile {
  path: string;
  /** Base name (`.env`, `.env.example`, `.env.appStore.example`, …; see env-files.ts). */
  name: EnvFileName;
  entries: EnvEntry[];
  /**
   * Commented-out keys (`# KEY=`) of a declaration file (env-files.ts): they declare the variable
   * (so it isn't MISSING) but are never UNUSED and take no part in MISMATCH. Empty for other files.
   */
  commented?: ReadonlyArray<{ key: string }>;
}

export interface ScopeInput {
  references: Reference[];
  envFiles: ScopeEnvFile[];
  isIgnored: (name: string) => boolean;
  /**
   * Names read outside the scanned code (test files, Compose interpolation) in this scope: they
   * keep a variable from being UNUSED, nothing more.
   */
  usedOutsideCode?: ReadonlySet<string>;
}

/**
 * Compare one scope's references against its env files.
 *
 * - missing:  referenced without an inline default, and not defined in any of the scope's env
 *             files, nor commented out in one of its declaration files (one row per reference). Never in a scope with no env file at all: nothing
 *             there declares anything yet, so the scope is reported once (EnvScope) instead.
 * - unused:   defined in an env file, never referenced in the scope (one row per defining file);
 *             a read in a test file or a Compose file's interpolation counts, so neither is unused
 * - mismatch: in `.env` but not `.env.example`, or the reverse; only when both exist
 */
export function analyzeScope({ references, envFiles, isIgnored, usedOutsideCode }: ScopeInput): FindingRow[] {
  const rows: FindingRow[] = [];
  const defined = new Set(envFiles.flatMap((f) => [...f.entries, ...(f.commented ?? [])].map((e) => e.key)));
  const referenced = new Set([...references.map((r) => r.name), ...(usedOutsideCode ?? [])]);

  for (const ref of envFiles.length === 0 ? [] : references) {
    if (isIgnored(ref.name) || ref.hasDefault || defined.has(ref.name)) continue;
    rows.push({ kind: 'missing', var_name: ref.name, file: ref.file, line: ref.line, env_file: null });
  }

  for (const envFile of envFiles) {
    for (const { key, line } of firstOccurrences(envFile.entries)) {
      if (isIgnored(key) || referenced.has(key)) continue;
      rows.push({ kind: 'unused', var_name: key, file: envFile.path, line, env_file: envFile.path });
    }
  }

  const dotenv = envFiles.find((f) => f.name === '.env');
  const example = envFiles.find((f) => f.name === '.env.example');
  if (dotenv && example) {
    for (const [present, absent] of [
      [dotenv, example],
      [example, dotenv],
    ] as const) {
      const absentKeys = new Set(absent.entries.map((e) => e.key));
      for (const { key, line } of firstOccurrences(present.entries)) {
        if (isIgnored(key) || absentKeys.has(key)) continue;
        rows.push({ kind: 'mismatch', var_name: key, file: present.path, line, env_file: absent.path });
      }
    }
  }

  return rows;
}

function firstOccurrences(entries: EnvEntry[]): EnvEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)));
}

const KIND_ORDER: Record<FindingKind, number> = { missing: 0, unused: 1, mismatch: 2 };

/**
 * Every variable the scope's code references (ignored names aside), sorted by name, with the
 * scope's env files that define it in display order (env-files.ts), and `optional` when every
 * reference has an inline default. Names only: env values are never read into the result.
 */
export function requiredVariables({ scope, references, envFiles, isIgnored }: ScopeInput & { scope: string }): RequiredVariable[] {
  // Indexed by name once, so this stays linear in references and env file entries.
  const allDefaulted = new Map<string, boolean>();
  for (const ref of references) allDefaulted.set(ref.name, (allDefaulted.get(ref.name) ?? true) && ref.hasDefault === true);
  const definedIn = new Map<string, EnvFileName[]>();
  for (const f of envFiles) {
    for (const key of new Set([...f.entries, ...(f.commented ?? [])].map((e) => e.key))) {
      const list = definedIn.get(key);
      if (list) list.push(f.name);
      else definedIn.set(key, [f.name]);
    }
  }
  const names = [...allDefaulted.keys()].filter((name) => !isIgnored(name)).sort();
  return names.map((var_name) => {
    const variable: RequiredVariable = { var_name, scope, defined_in: sortEnvFileNames(definedIn.get(var_name) ?? []) };
    if (allDefaulted.get(var_name)) variable.optional = true;
    return variable;
  });
}

/** Deterministic order: kind, then variable name, then file, then line. */
export function compareFindings(a: FindingRow, b: FindingRow): number {
  return (
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    compareStrings(a.var_name, b.var_name) ||
    compareStrings(a.file ?? '', b.file ?? '') ||
    (a.line ?? 0) - (b.line ?? 0)
  );
}

/** Counts are distinct variable names per kind, so ten uses of one missing var count once. */
export function summarize(findings: readonly Pick<FindingRow, 'kind' | 'var_name'>[]): FindingCounts {
  const names: Record<FindingKind, Set<string>> = { missing: new Set(), unused: new Set(), mismatch: new Set() };
  for (const f of findings) names[f.kind].add(f.var_name);
  return { missing: names.missing.size, unused: names.unused.size, mismatch: names.mismatch.size };
}

/**
 * MISSING variables in `current` that were not MISSING in `previous` (sorted). With no previous
 * scan to compare against, every current MISSING variable counts as new.
 */
export function newMissingVars(
  current: readonly Pick<FindingRow, 'kind' | 'var_name'>[],
  previous: readonly Pick<FindingRow, 'kind' | 'var_name'>[] | null,
): string[] {
  const before = new Set((previous ?? []).filter((f) => f.kind === 'missing').map((f) => f.var_name));
  const now = new Set(current.filter((f) => f.kind === 'missing').map((f) => f.var_name));
  return [...now].filter((name) => !before.has(name)).sort();
}

/**
 * For deploy correlation in scopes with no env file (which have no MISSING rows): the variables
 * those scopes reference, optional ones aside, that the previous scanned deploy didn't reference
 * at all (sorted). `previousNames` is everything the previous scan referenced, or null when there
 * is no previous scan, in which case every such variable counts as new. A scan from a CLI before
 * 0.2.0 has no `envScopes` (null): nothing, so it correlates exactly as it always has.
 */
export function newUndeclaredVars(
  current: { variables: readonly RequiredVariable[]; envScopes: readonly EnvScope[] | null },
  previousNames: ReadonlySet<string> | null,
): string[] {
  if (!current.envScopes) return [];
  const bare = new Set(current.envScopes.filter((s) => s.env_files.length === 0).map((s) => s.scope));
  const names = current.variables.filter((v) => bare.has(v.scope) && !v.optional).map((v) => v.var_name);
  return [...new Set(names)].filter((name) => !previousNames?.has(name)).sort();
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

import type { EnvEntry } from './env-parser';
import { ENV_FILE_BASENAMES, type FindingCounts, type FindingKind, type FindingRow, type Reference, type RequiredVariable } from './types';

/** An env file that belongs to a scope. `path` is relative to the scan root. */
export interface ScopeEnvFile {
  path: string;
  /** Base name: `.env`, `.env.example` or `.env.local`. */
  name: string;
  entries: EnvEntry[];
}

export interface ScopeInput {
  references: Reference[];
  envFiles: ScopeEnvFile[];
  isIgnored: (name: string) => boolean;
}

/**
 * Compare one scope's references against its env files.
 *
 * - missing:  referenced, but not defined in any of the scope's env files (one row per reference)
 * - unused:   defined in an env file, never referenced in the scope (one row per defining file)
 * - mismatch: in `.env` but not `.env.example`, or the reverse; only when both exist
 */
export function analyzeScope({ references, envFiles, isIgnored }: ScopeInput): FindingRow[] {
  const rows: FindingRow[] = [];
  const defined = new Set(envFiles.flatMap((f) => f.entries.map((e) => e.key)));
  const referenced = new Set(references.map((r) => r.name));

  for (const ref of references) {
    if (isIgnored(ref.name) || defined.has(ref.name)) continue;
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
 * scope's env files that define it in ENV_FILE_BASENAMES order. Names only: env values are never
 * read into the result. An empty `defined_in` is a MISSING variable.
 */
export function requiredVariables({ scope, references, envFiles, isIgnored }: ScopeInput & { scope: string }): RequiredVariable[] {
  const names = [...new Set(references.map((r) => r.name))].filter((name) => !isIgnored(name)).sort();
  return names.map((var_name) => ({
    var_name,
    scope,
    defined_in: ENV_FILE_BASENAMES.filter((basename) =>
      envFiles.some((f) => f.name === basename && f.entries.some((e) => e.key === var_name)),
    ),
  }));
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

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

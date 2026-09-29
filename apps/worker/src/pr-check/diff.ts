import type { ScanResult } from '@deployhealth/core';
import type { PrAddedVar, PrEnvFile, PrRemovedVar, PrRenamedVar, PrVarRef } from '@deployhealth/db';

/** References stored and shown per variable; `total` keeps the real count. */
export const PR_REFS_PER_VAR = 20;

export interface EnvVarDiff {
  added: PrAddedVar[];
  removed: PrRemovedVar[];
  renamed: PrRenamedVar[];
  /** Added (or renamed-to) variables missing from the .env.example of a scope that reads them. */
  undeclared: string[];
}

type Ref = ScanResult['references'][number];

function refsByName(scan: ScanResult): Map<string, Ref[]> {
  const byName = new Map<string, Ref[]>();
  for (const ref of scan.references) byName.set(ref.name, [...(byName.get(ref.name) ?? []), ref]);
  return byName;
}

const toStored = (refs: readonly Ref[]): PrVarRef[] => refs.slice(0, PR_REFS_PER_VAR).map((r) => ({ file: r.file, line: r.line }));

/**
 * What a pull request does to env var references, by variable: a variable is **added** when head
 * reads it and base doesn't anywhere, **removed** the other way round. A removed and an added
 * variable read in the same file are paired as a **rename** (in order of first appearance in that
 * file). A variable is **declared** when every scope that reads it in head lists it in its
 * `.env.example`.
 */
export function diffEnvVars(base: ScanResult, head: ScanResult): EnvVarDiff {
  const baseRefs = refsByName(base);
  const headRefs = refsByName(head);
  const addedNames = [...headRefs.keys()].filter((n) => !baseRefs.has(n)).sort();
  const removedNames = [...baseRefs.keys()].filter((n) => !headRefs.has(n)).sort();

  const declared = (name: string) => {
    const scopes = head.variables.filter((v) => v.var_name === name);
    return scopes.length > 0 && scopes.every((v) => v.defined_in.includes('.env.example'));
  };
  const firstLineIn = (refs: readonly Ref[], file: string) => Math.min(...refs.filter((r) => r.file === file).map((r) => r.line));

  // Renames: pair removed and added variables that share a file.
  const renamed: PrRenamedVar[] = [];
  const paired = new Set<string>();
  const files = [...new Set([...removedNames.flatMap((n) => baseRefs.get(n)!.map((r) => r.file))])].sort();
  for (const file of files) {
    const gone = removedNames.filter((n) => !paired.has(n) && baseRefs.get(n)!.some((r) => r.file === file));
    const fresh = addedNames.filter((n) => !paired.has(n) && headRefs.get(n)!.some((r) => r.file === file));
    gone.sort((a, b) => firstLineIn(baseRefs.get(a)!, file) - firstLineIn(baseRefs.get(b)!, file));
    fresh.sort((a, b) => firstLineIn(headRefs.get(a)!, file) - firstLineIn(headRefs.get(b)!, file));
    for (let i = 0; i < Math.min(gone.length, fresh.length); i++) {
      const [from, to] = [gone[i]!, fresh[i]!];
      paired.add(from).add(to);
      renamed.push({ from, to, file, line: firstLineIn(headRefs.get(to)!, file), declared: declared(to) });
    }
  }

  const added = addedNames
    .filter((n) => !paired.has(n))
    .map((name) => ({ name, refs: toStored(headRefs.get(name)!), total: headRefs.get(name)!.length, declared: declared(name) }));
  const removed = removedNames
    .filter((n) => !paired.has(n))
    .map((name) => ({ name, refs: toStored(baseRefs.get(name)!), total: baseRefs.get(name)!.length }));
  const undeclared = [...added.filter((a) => !a.declared).map((a) => a.name), ...renamed.filter((r) => !r.declared).map((r) => r.to)].sort();

  return { added, removed, renamed, undeclared };
}

/** `.env`, `.env.local` and `.env.<anything>.local`, at any depth. `.env.example` is meant to be committed. */
export function isCommittableSecretEnvFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name === '.env' || name === '.env.local' || /^\.env\..+\.local$/.test(name);
}

/** Env files the pull request adds or changes (by blob sha); ones already on the base branch unchanged don't count. */
export function committedEnvFiles(base: ReadonlyArray<{ path: string; sha: string }>, head: ReadonlyArray<{ path: string; sha: string }>): PrEnvFile[] {
  const before = new Map(base.map((b) => [b.path, b.sha]));
  return head
    .filter((h) => isCommittableSecretEnvFile(h.path) && before.get(h.path) !== h.sha)
    .map((h) => ({ path: h.path, added: !before.has(h.path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

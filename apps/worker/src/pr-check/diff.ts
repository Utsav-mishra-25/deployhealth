import { isDeclarationFile, type ScanResult } from '@deployhealth/core';
import type { PrAddedVar, PrEnvFile, PrRemovedVar, PrRenamedVar, PrVarRef } from '@deployhealth/db';

/** References stored and shown per variable; `total` keeps the real count. */
export const PR_REFS_PER_VAR = 20;

export interface EnvVarDiff {
  added: PrAddedVar[];
  removed: PrRemovedVar[];
  renamed: PrRenamedVar[];
  /** Added (or renamed-to) variables missing from the declaration files of a scope that reads them. */
  undeclared: string[];
}

type Ref = ScanResult['references'][number];

function refsByName(scan: ScanResult): Map<string, Ref[]> {
  const byName = new Map<string, Ref[]>();
  for (const ref of scan.references) {
    const list = byName.get(ref.name);
    if (list) list.push(ref);
    else byName.set(ref.name, [ref]);
  }
  return byName;
}

/** For each of `names`, the files it's read in and its first line in each, by file. */
function firstLinesByFile(names: readonly string[], refs: ReadonlyMap<string, Ref[]>): Map<string, Map<string, number>> {
  const byFile = new Map<string, Map<string, number>>();
  for (const name of names) {
    for (const ref of refs.get(name)!) {
      let lines = byFile.get(ref.file);
      if (!lines) byFile.set(ref.file, (lines = new Map()));
      const first = lines.get(name);
      if (first === undefined || ref.line < first) lines.set(name, ref.line);
    }
  }
  return byFile;
}

const toStored = (refs: readonly Ref[]): PrVarRef[] => refs.slice(0, PR_REFS_PER_VAR).map((r) => ({ file: r.file, line: r.line }));

/**
 * What a pull request does to env var references, by variable: a variable is **added** when head
 * reads it and base doesn't anywhere, **removed** the other way round. A removed and an added
 * variable read in the same file are paired as a **rename** (in order of first appearance in that
 * file). A variable is **declared** when every scope that reads it in head lists it in a
 * declaration file (`.env.example`, `.env.sample`, `.env.<name>.example`, …), or the code supplies
 * a default wherever it reads it (optional). Names the
 * platform or runtime provides (DEFAULT_IGNORE) never appear: the scans skip them.
 */
export function diffEnvVars(base: ScanResult, head: ScanResult): EnvVarDiff {
  const baseRefs = refsByName(base);
  const headRefs = refsByName(head);
  const addedNames = [...headRefs.keys()].filter((n) => !baseRefs.has(n)).sort();
  const removedNames = [...baseRefs.keys()].filter((n) => !headRefs.has(n)).sort();

  // Every index below is built once, so the diff stays linear in references and variables.
  const scopesByName = new Map<string, Array<ScanResult['variables'][number]>>();
  for (const v of head.variables) {
    const list = scopesByName.get(v.var_name);
    if (list) list.push(v);
    else scopesByName.set(v.var_name, [v]);
  }
  const declared = (name: string) => {
    const scopes = scopesByName.get(name) ?? [];
    return scopes.length > 0 && scopes.every((v) => v.optional || v.defined_in.some(isDeclarationFile));
  };

  // Renames: pair removed and added variables that share a file, in order of first appearance there.
  const renamed: PrRenamedVar[] = [];
  const paired = new Set<string>();
  const goneByFile = firstLinesByFile(removedNames, baseRefs);
  const freshByFile = firstLinesByFile(addedNames, headRefs);
  const byFirstLine = (lines: ReadonlyMap<string, number>) => (a: string, b: string) => lines.get(a)! - lines.get(b)! || (a < b ? -1 : a > b ? 1 : 0);
  for (const file of [...goneByFile.keys()].sort()) {
    const freshLines = freshByFile.get(file);
    if (!freshLines) continue;
    const goneLines = goneByFile.get(file)!;
    const gone = [...goneLines.keys()].filter((n) => !paired.has(n)).sort(byFirstLine(goneLines));
    const fresh = [...freshLines.keys()].filter((n) => !paired.has(n)).sort(byFirstLine(freshLines));
    for (let i = 0; i < Math.min(gone.length, fresh.length); i++) {
      const [from, to] = [gone[i]!, fresh[i]!];
      paired.add(from).add(to);
      renamed.push({ from, to, file, line: freshLines.get(to)!, declared: declared(to) });
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

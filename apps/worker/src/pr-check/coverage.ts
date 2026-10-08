import { passesTreeRules, SUPPORTED_LANGUAGES, supportedLanguageOf, treeMarkers, unreadExtensionOf, type LanguageId, type TreeMarkers } from '@deployhealth/core';

/**
 * What a pull request check reads, worked out from the two tree listings alone (paths, blob shas
 * and sizes; no file contents), so it's known before any blob is downloaded. Runs in the isolate
 * with the rest of the selection. Each pass is linear in the number of tree entries.
 */
export interface Coverage {
  /** Supported source files read in head, per language (every language present, 0 if none). */
  sourceByLanguage: Record<LanguageId, number>;
  /** Their total. 0: the check can't read this repo. */
  sourceFiles: number;
  /** Every file read in head: supported source, env and declaration files, Compose files. */
  readFiles: number;
  /** Files read (on either side) that the pull request adds, changes or deletes. */
  changedRead: number;
  /** Source files in head the scanner doesn't read, by extension (same skip, vendored and test rules). */
  unsupported: Record<string, number>;
  /** Of those (on either side), the ones the pull request adds, changes or deletes, by extension. */
  unsupportedChanged: Record<string, number>;
}

export interface TreeEntry {
  path: string;
  sha: string;
}

/**
 * `selectedBase` / `selectedHead` are the paths `selectTreeFiles` chose on each side; `base` /
 * `head` are every blob of each tree.
 */
export function treeCoverage(
  base: readonly TreeEntry[],
  head: readonly TreeEntry[],
  selectedBase: readonly string[],
  selectedHead: readonly string[],
): Coverage {
  const baseSha = new Map(base.map((b) => [b.path, b.sha]));
  const headSha = new Map(head.map((h) => [h.path, h.sha]));
  const differs = (path: string) => baseSha.get(path) !== headSha.get(path);

  const sourceByLanguage = Object.fromEntries(SUPPORTED_LANGUAGES.map((l) => [l.id, 0])) as Record<LanguageId, number>;
  let sourceFiles = 0;
  for (const path of selectedHead) {
    const language = supportedLanguageOf(path);
    if (!language) continue; // env, declaration and Compose files
    sourceByLanguage[language.id]++;
    sourceFiles++;
  }

  // A read file changed: added or modified in head, or deleted from base.
  let changedRead = 0;
  const selectedHeadSet = new Set(selectedHead);
  for (const path of selectedHead) if (differs(path)) changedRead++;
  for (const path of selectedBase) if (!selectedHeadSet.has(path) && differs(path)) changedRead++;

  const unsupported: Record<string, number> = {};
  const unsupportedChanged: Record<string, number> = {};
  // The same skip rules as selectTreeFiles, with each side's marker files (Laravel's storage/).
  const headMarkers = treeMarkers(head.map((h) => h.path));
  const baseMarkers = treeMarkers(base.map((b) => b.path));
  const unread = (path: string, markers: TreeMarkers) => (passesTreeRules(path, { markers }) ? unreadExtensionOf(path) : null);
  for (const { path } of head) {
    const ext = unread(path, headMarkers);
    if (!ext) continue;
    unsupported[ext] = (unsupported[ext] ?? 0) + 1;
    if (differs(path)) unsupportedChanged[ext] = (unsupportedChanged[ext] ?? 0) + 1;
  }
  for (const { path } of base) {
    if (headSha.has(path)) continue; // counted above
    const ext = unread(path, baseMarkers);
    if (ext) unsupportedChanged[ext] = (unsupportedChanged[ext] ?? 0) + 1;
  }

  return { sourceByLanguage, sourceFiles, readFiles: selectedHead.length, changedRead, unsupported, unsupportedChanged };
}

/** "12 .java, 3 .properties files" (most first, then by extension), or '' when there are none. */
export function describeExtensionCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (entries.length === 0) return '';
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return `${entries.map(([ext, n]) => `${n} ${ext}`).join(', ')} ${total === 1 ? 'file' : 'files'}`;
}

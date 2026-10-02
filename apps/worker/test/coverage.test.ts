import { selectTreeFiles } from '@deployhealth/core';
import { describe, expect, it } from 'vitest';
import { describeExtensionCounts, treeCoverage, type TreeEntry } from '../src/pr-check/coverage';

const entries = (files: Record<string, string>): TreeEntry[] => Object.entries(files).map(([path, sha]) => ({ path, sha }));
const coverageOf = (base: Record<string, string>, head: Record<string, string>) => {
  const [b, h] = [entries(base), entries(head)];
  return treeCoverage(b, h, selectTreeFiles(Object.keys(base)), selectTreeFiles(Object.keys(head)));
};

describe('treeCoverage', () => {
  it('counts read files per language, unread source by extension, and what the pull request changed', () => {
    const base = { 'src/a.ts': '1', 'src/gone.ts': '2', 'api/app.py': '3', '.env.example': '4', 'App.java': '5', 'Old.java': '6', 'node_modules/x/Y.java': '7' };
    const head = { 'src/a.ts': '1', 'api/app.py': '3b', '.env.example': '4', 'App.java': '5b', 'New.kt': '8', 'node_modules/x/Y.java': '7b', 'src/a.test.ts': '9' };
    expect(coverageOf(base, head)).toEqual({
      sourceByLanguage: { javascript: 1, python: 1, go: 0, ruby: 0 },
      sourceFiles: 2,
      readFiles: 3, // src/a.ts, api/app.py, .env.example (the test file isn't read)
      changedRead: 2, // api/app.py changed, src/gone.ts deleted
      unsupported: { '.java': 1, '.kt': 1 }, // node_modules never counts
      unsupportedChanged: { '.java': 2, '.kt': 1 }, // App.java changed, Old.java deleted, New.kt added
    });
  });

  it('describes counts by extension, most first', () => {
    expect(describeExtensionCounts({ '.kt': 1, '.java': 12, '.properties': 3 })).toBe('12 .java, 3 .properties, 1 .kt files');
    expect(describeExtensionCounts({ '.java': 1 })).toBe('1 .java file');
    expect(describeExtensionCounts({})).toBe('');
  });

  // Tree listings come from the pull request's repository, so they're untrusted input: 100,000
  // entries per side (GitHub's limit for one recursive tree), with deep paths. About 0.8 s alone
  // (selection included) and about twice that when CI runs every package at once, so 6 s; a version
  // that looks paths up in arrays instead of maps spends about 100 s in treeCoverage alone.
  it('is linear in the tree size: 100,000 entries per side in under 6 s', () => {
    const n = 100_000;
    const deep = 'a/b/c/d/e/f/g/h/i/j/';
    const base: TreeEntry[] = [];
    const head: TreeEntry[] = [];
    for (let i = 0; i < n; i++) {
      const path = `${deep}${i % 7}/f${i}.${['ts', 'java', 'py', 'md', 'kt', 'go', 'rb'][i % 7]}`;
      base.push({ path, sha: `s${i}` });
      head.push({ path, sha: i % 3 === 0 ? `t${i}` : `s${i}` });
    }
    const started = performance.now();
    const selectedBase = selectTreeFiles(base.map((b) => b.path));
    const selectedHead = selectTreeFiles(head.map((h) => h.path));
    const coverage = treeCoverage(base, head, selectedBase, selectedHead);
    const ms = performance.now() - started;
    expect(coverage.sourceFiles).toBeGreaterThan(50_000);
    expect(coverage.changedRead).toBeGreaterThan(15_000);
    expect(ms).toBeLessThan(6_000);
  });
});

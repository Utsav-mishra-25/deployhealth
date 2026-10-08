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
    const base = { 'src/a.ts': '1', 'src/gone.ts': '2', 'api/app.py': '3', '.env.example': '4', 'svc/main.rs': '5', 'svc/old.rs': '6', 'node_modules/x/y.rs': '7', 'App.java': 'j' };
    const head = { 'src/a.ts': '1', 'api/app.py': '3b', '.env.example': '4', 'svc/main.rs': '5b', 'ios/App.swift': '8', 'node_modules/x/y.rs': '7b', 'src/a.test.ts': '9', 'App.java': 'j' };
    expect(coverageOf(base, head)).toEqual({
      sourceByLanguage: { javascript: 1, python: 1, go: 0, ruby: 0, php: 0, jvm: 1 },
      sourceFiles: 3,
      readFiles: 4, // src/a.ts, api/app.py, App.java, .env.example (the test file isn't read)
      changedRead: 2, // api/app.py changed, src/gone.ts deleted
      unsupported: { '.rs': 1, '.swift': 1 }, // node_modules never counts
      unsupportedChanged: { '.rs': 2, '.swift': 1 }, // main.rs changed, old.rs deleted, App.swift added
    });
  });

  it('describes counts by extension, most first', () => {
    expect(describeExtensionCounts({ '.swift': 1, '.rs': 12, '.cs': 3 })).toBe('12 .rs, 3 .cs, 1 .swift files');
    expect(describeExtensionCounts({ '.rs': 1 })).toBe('1 .rs file');
    expect(describeExtensionCounts({})).toBe('');
  });

  // Tree listings come from the pull request's repository, so they're untrusted input: 100,000
  // entries per side (GitHub's limit for one recursive tree), with deep paths. About 0.8 s alone
  // (selection included) and about twice that with every package running at once, measured in a
  // sandbox, not on GitHub's runners (where a 3 s bound went flaky before), so 15 s; a version that
  // looks paths up in arrays instead of maps spends about 100 s in treeCoverage alone, over 6x more.
  it('is linear in the tree size: 100,000 entries per side in under 15 s', () => {
    const n = 100_000;
    const deep = 'a/b/c/d/e/f/g/h/i/j/';
    const base: TreeEntry[] = [];
    const head: TreeEntry[] = [];
    for (let i = 0; i < n; i++) {
      const path = `${deep}${i % 7}/f${i}.${['ts', 'rs', 'py', 'md', 'cs', 'go', 'rb'][i % 7]}`;
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
    expect(ms).toBeLessThan(15_000);
  });
});

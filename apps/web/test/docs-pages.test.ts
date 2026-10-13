import { scanFiles, selectTreeFiles } from '@deployhealth/core';
import { describe, expect, it } from 'vitest';
import { DOCS_INDEX, DOCS_SLUGS, STACK_DOCS, type DocsExample } from '@/lib/docs-pages';

// The docs pages can't drift from the scanner: every example they show is scanned here, the way
// the GitHub App scans a pull request (selectTreeFiles, then scanFiles), and must produce exactly
// the reads, OPTIONAL flags, MISSING and UNUSED names the page prints. Nothing more, nothing less.

const examples = DOCS_SLUGS.flatMap((slug) => STACK_DOCS[slug].sections.flatMap((s) => s.examples ?? []));

async function scan(example: DocsExample) {
  const all = new Map(example.files.map((f) => [f.path, f.code]));
  const chosen = selectTreeFiles([...all.keys()]);
  const result = await scanFiles(new Map(chosen.map((path) => [path, all.get(path)!])));
  const names = (kind: string) => [...new Set(result.findings.filter((f) => f.kind === kind).map((f) => f.var_name))].sort();
  return {
    reads: result.references
      .map((r) => ({ name: r.name, file: r.file, line: r.line, ...(r.hasDefault ? { optional: true as const } : {}) }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name)),
    missing: names('missing'),
    unused: names('unused'),
    optional: result.variables.filter((v) => v.optional).map((v) => v.var_name),
  };
}

describe('every docs example scans to exactly what its page says', () => {
  it.each(examples.map((e) => [e.id, e] as const))('%s', async (_id, example) => {
    const actual = await scan(example);
    expect({ reads: actual.reads, missing: actual.missing, unused: actual.unused }).toEqual({
      reads: example.reads,
      missing: example.missing,
      unused: example.unused,
    });
    // A variable the page marks optional everywhere it's read is OPTIONAL in the scan's variable list.
    const claimedOptional = [...new Set(example.reads.map((r) => r.name))].filter((name) =>
      example.reads.filter((r) => r.name === name).every((r) => r.optional),
    );
    expect(actual.optional.sort()).toEqual(expect.arrayContaining(claimedOptional.sort()));
  });

  it('shows every file in path order, so the page reads like a repository', () => {
    for (const example of examples) {
      const paths = example.files.map((f) => f.path);
      expect(paths, example.id).toEqual([...paths].sort());
      expect(new Set(paths).size, example.id).toBe(paths.length);
    }
  });

  it('would catch drift: a claim the scanner disagrees with fails the comparison', async () => {
    const example = STACK_DOCS.nextjs.sections[0]!.examples![0]!;
    const actual = await scan(example);
    const shifted = example.reads.map((r, i) => (i === 0 ? { ...r, line: r.line + 1 } : r));
    expect(actual.reads).not.toEqual(shifted);
    expect(actual.reads).not.toEqual([...example.reads, { name: 'EXTRA', file: 'lib/db.ts', line: 1 }]);
    expect(actual.missing).not.toEqual([]);
  });

  it('has unique example ids', () => {
    expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
  });
});

describe('docs metadata is written for search', () => {
  const pages = [DOCS_INDEX, ...DOCS_SLUGS.map((slug) => STACK_DOCS[slug])];

  it('titles under 60 characters and descriptions under 155, all distinct', () => {
    for (const page of pages) {
      expect(page.title.length, page.title).toBeLessThanOrEqual(60);
      expect(page.description.length, page.description).toBeLessThanOrEqual(155);
      expect(page.description.length, page.description).toBeGreaterThan(70);
    }
    expect(new Set(pages.map((p) => p.title)).size).toBe(pages.length);
    expect(new Set(pages.map((p) => p.description)).size).toBe(pages.length);
  });

  it('each stack page is problem-first and covers reads, defaults, skips and limits', () => {
    for (const slug of DOCS_SLUGS) {
      const doc = STACK_DOCS[slug];
      expect(doc.h1).toBe(`How to catch a missing env var in ${doc.stack} before it reaches production`);
      expect(doc.sections.map((s) => s.id)).toEqual(['reads', 'defaults', 'skips', 'limits']);
    }
  });

  it('never shows a value: env files in examples declare names with empty values (or only comments)', () => {
    for (const example of examples) {
      for (const file of example.files.filter((f) => /(^|\/)\.env/.test(f.path))) {
        for (const line of file.code.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))) {
          expect(line, `${example.id} ${file.path}`).toMatch(/^[A-Z_][A-Z0-9_]*=$/);
        }
      }
    }
  });
});

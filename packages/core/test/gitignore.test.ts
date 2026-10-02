import { describe, expect, it } from 'vitest';
import { GitignoreMatcher, parseGitignore } from '../src/gitignore';

function matcher(source: string, base = ''): GitignoreMatcher {
  return GitignoreMatcher.empty().extend(base, source);
}

describe('parseGitignore', () => {
  it('ignores blank lines and comments, keeps escaped # and !', () => {
    const rules = parseGitignore('\n# comment\n\\#literal\n\\!bang\nfoo');
    expect(rules.map((r) => r.source)).toEqual(['\\#literal', '\\!bang', 'foo']);
  });
});

describe('GitignoreMatcher', () => {
  it('matches unanchored names at any depth', () => {
    const m = matcher('*.log\nbuild');
    expect(m.ignores('debug.log', false)).toBe(true);
    expect(m.ignores('a/b/debug.log', false)).toBe(true);
    expect(m.ignores('build', true)).toBe(true);
    expect(m.ignores('pkg/build', true)).toBe(true);
    expect(m.ignores('debug.txt', false)).toBe(false);
  });

  it('anchors patterns with a leading or inner slash', () => {
    const m = matcher('/root-only.ts\ndocs/generated');
    expect(m.ignores('root-only.ts', false)).toBe(true);
    expect(m.ignores('sub/root-only.ts', false)).toBe(false);
    expect(m.ignores('docs/generated', true)).toBe(true);
    expect(m.ignores('pkg/docs/generated', true)).toBe(false);
  });

  it('applies directory-only patterns to directories only', () => {
    const m = matcher('cache/');
    expect(m.ignores('cache', true)).toBe(true);
    expect(m.ignores('cache', false)).toBe(false);
    expect(m.ignores('a/cache', true)).toBe(true);
  });

  it('supports negation with last-match-wins', () => {
    const m = matcher('*.env.ts\n!keep.env.ts');
    expect(m.ignores('drop.env.ts', false)).toBe(true);
    expect(m.ignores('keep.env.ts', false)).toBe(false);
    const reordered = matcher('!keep.env.ts\n*.env.ts');
    expect(reordered.ignores('keep.env.ts', false)).toBe(true);
  });

  it('handles ** in leading, trailing and inner positions', () => {
    const m = matcher('**/tmp\nout/**\na/**/z.ts');
    expect(m.ignores('tmp', true)).toBe(true);
    expect(m.ignores('x/y/tmp', true)).toBe(true);
    expect(m.ignores('out/file.ts', false)).toBe(true);
    expect(m.ignores('out/deep/file.ts', false)).toBe(true);
    expect(m.ignores('out', true)).toBe(false);
    expect(m.ignores('a/z.ts', false)).toBe(true);
    expect(m.ignores('a/b/c/z.ts', false)).toBe(true);
    expect(m.ignores('b/z.ts', false)).toBe(false);
  });

  it('supports ? and character classes', () => {
    const m = matcher('file?.ts\nlog[0-9].txt\nv[!0-9].js');
    expect(m.ignores('file1.ts', false)).toBe(true);
    expect(m.ignores('file12.ts', false)).toBe(false);
    expect(m.ignores('log7.txt', false)).toBe(true);
    expect(m.ignores('logx.txt', false)).toBe(false);
    expect(m.ignores('va.js', false)).toBe(true);
    expect(m.ignores('v1.js', false)).toBe(false);
  });

  it('does not let * cross directory boundaries', () => {
    const m = matcher('src/*.ts');
    expect(m.ignores('src/a.ts', false)).toBe(true);
    expect(m.ignores('src/nested/a.ts', false)).toBe(false);
  });

  it('escapes regex metacharacters in literal text', () => {
    const m = matcher('a+b(1).ts');
    expect(m.ignores('a+b(1).ts', false)).toBe(true);
    expect(m.ignores('aab(1)xts', false)).toBe(false);
  });

  it('keeps an escaped trailing space', () => {
    expect(matcher('name\\ ').ignores('name ', false)).toBe(true);
    expect(matcher('name   ').ignores('name', false)).toBe(true);
  });

  it('scopes rules to the directory that owns the .gitignore', () => {
    const m = matcher('/local.ts\n*.gen.ts', 'pkg');
    expect(m.ignores('pkg/local.ts', false)).toBe(true);
    expect(m.ignores('local.ts', false)).toBe(false);
    expect(m.ignores('pkg/deep/x.gen.ts', false)).toBe(true);
    expect(m.ignores('other/x.gen.ts', false)).toBe(false);
  });

  it('lets deeper .gitignore files override shallower ones', () => {
    const m = GitignoreMatcher.empty().extend('', '*.secret.ts').extend('pkg', '!public.secret.ts');
    expect(m.ignores('pkg/public.secret.ts', false)).toBe(false);
    expect(m.ignores('pkg/private.secret.ts', false)).toBe(true);
    expect(m.ignores('public.secret.ts', false)).toBe(true);
  });
});

describe('GitignoreMatcher on hostile patterns (linear time, never throws)', () => {
  const timed = (fn: () => unknown) => {
    const started = performance.now();
    const value = fn();
    return { value, ms: performance.now() - started };
  };

  it('matches twenty `*a` and a `b` against a 200-character name in well under 50 ms', () => {
    const pattern = `${'*a'.repeat(20)}b`;
    const { value, ms } = timed(() => matcher(pattern).ignores('a'.repeat(200), false));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(50);
    expect(matcher(pattern).ignores(`${'a'.repeat(200)}b`, false)).toBe(true);
  });

  it('reads `[]|(a+)+b]` as one class of single characters: no alternation, no backtracking', () => {
    const m = matcher('[]|(a+)+b]');
    for (const one of [']', '|', '(', 'a', '+', ')', 'b']) expect(m.ignores(one, false)).toBe(true);
    expect(m.ignores('x', false)).toBe(false);
    expect(m.ignores('ab', false)).toBe(false);
    expect(m.ignores('b]', false)).toBe(false);
    const { value, ms } = timed(() => m.ignores(`${'a'.repeat(10_000)}c`, false));
    expect(value).toBe(false);
    expect(ms).toBeLessThan(50);
  });

  it('treats a reversed range as empty instead of throwing', () => {
    expect(() => matcher('[z-a]')).not.toThrow();
    expect(matcher('[z-a]').ignores('m', false)).toBe(false);
    expect(matcher('[!z-a]').ignores('m', false)).toBe(true);
  });

  it('never matches with an invalid class: unclosed, or an unknown [:name:]', () => {
    expect(matcher('[abc').ignores('[abc', false)).toBe(false);
    expect(matcher('[abc').ignores('a', false)).toBe(false);
    expect(matcher('[[:nope:]]').ignores('a', false)).toBe(false);
  });

  it('follows git for classes: ] first is literal, ^ negates, escapes, POSIX names, never /', () => {
    expect(matcher('x[]]').ignores('x]', false)).toBe(true);
    expect(matcher('v[^0-9].js').ignores('va.js', false)).toBe(true);
    expect(matcher('v[^0-9].js').ignores('v1.js', false)).toBe(false);
    expect(matcher('a[\\]]b').ignores('a]b', false)).toBe(true);
    expect(matcher('log[[:digit:]].txt').ignores('log4.txt', false)).toBe(true);
    expect(matcher('log[[:digit:]].txt').ignores('logx.txt', false)).toBe(false);
    expect(matcher('a[!x]b').ignores('a/b', false)).toBe(false);
    expect(matcher('a?b').ignores('a/b', false)).toBe(false);
  });

  it('drops patterns over 1,024 characters and keeps the first 1,000 rules of a file', () => {
    expect(matcher(`${'x'.repeat(1_025)}`).ignores('x'.repeat(1_025), false)).toBe(false);
    expect(matcher(`${'x'.repeat(1_024)}`).ignores('x'.repeat(1_024), false)).toBe(true);
    const many = Array.from({ length: 1_001 }, (_, i) => `f${i}`).join('\n');
    expect(parseGitignore(many)).toHaveLength(1_000);
    expect(matcher(many).ignores('f999', false)).toBe(true);
    expect(matcher(many).ignores('f1000', false)).toBe(false);
  });
});

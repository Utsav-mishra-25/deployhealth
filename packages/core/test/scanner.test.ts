import { describe, expect, it } from 'vitest';
import { languageForFile, scanSource, type Language } from '../src/scanner';

const names = (source: string, language: Language) =>
  scanSource(source, language, 'f').map((r) => r.name);

describe('languageForFile', () => {
  it('maps supported extensions case-insensitively', () => {
    expect(languageForFile('a.ts')).toBe('javascript');
    expect(languageForFile('a.TSX')).toBe('javascript');
    expect(languageForFile('a.js')).toBe('javascript');
    expect(languageForFile('a.jsx')).toBe('javascript');
    expect(languageForFile('a.py')).toBe('python');
    expect(languageForFile('a.go')).toBe('go');
    expect(languageForFile('a.rb')).toBe('ruby');
    for (const ext of ['mjs', 'cjs', 'mts', 'cts', 'MJS']) expect(languageForFile(`a.${ext}`), ext).toBe('javascript');
    expect(languageForFile('a.md')).toBeUndefined();
    expect(languageForFile('Makefile')).toBeUndefined();
  });
});

describe('scanSource: JavaScript / TypeScript', () => {
  it('detects process.env dot access, including optional chaining', () => {
    expect(names('const a = process.env.API_KEY;\nprocess.env?.OPTIONAL_ONE', 'javascript')).toEqual([
      'API_KEY',
      'OPTIONAL_ONE',
    ]);
  });

  it('detects process.env bracket access with every quote style', () => {
    const src = `process.env["DOUBLE"]; process.env['SINGLE']; process.env[\`TICK\`]; process.env[ "SPACED" ]; process.env?.["OPT"]`;
    expect(names(src, 'javascript')).toEqual(['DOUBLE', 'SINGLE', 'TICK', 'SPACED', 'OPT']);
  });

  it('detects import.meta.env in both forms', () => {
    const src = 'import.meta.env.VITE_URL\nimport.meta.env["VITE_FLAG"]\nimport.meta.env?.VITE_OPT';
    expect(names(src, 'javascript')).toEqual(['VITE_URL', 'VITE_FLAG', 'VITE_OPT']);
  });

  it('ignores dynamic keys, mismatched quotes and look-alikes', () => {
    const src = [
      'process.env[name]',
      'process.env["MIXED\']',
      'process.env[`TEMPLATE_${x}`]',
      'myprocess.env.NOPE',
      'process.environment.NOPE',
    ].join('\n');
    expect(names(src, 'javascript')).toEqual([]);
  });

  it('records 1-based line and column of each access and finds several per line', () => {
    const refs = scanSource('\n  x(process.env.A, process.env["B"])', 'javascript', 'src/x.ts');
    expect(refs).toEqual([
      { name: 'A', file: 'src/x.ts', line: 2, column: 5, syntax: 'process.env' },
      { name: 'B', file: 'src/x.ts', line: 2, column: 20, syntax: 'process.env' },
    ]);
  });

  it('does not apply other languages’ patterns', () => {
    expect(names('os.getenv("PY")\nENV["RB"]\nos.Getenv("GO")', 'javascript')).toEqual([]);
  });
});

describe('scanSource: Python', () => {
  it('detects os.environ[...], os.environ.get(...) and os.getenv(...)', () => {
    const src = [
      'a = os.environ["DOUBLE"]',
      "b = os.environ['SINGLE']",
      'c = os.environ.get("GET_ONE")',
      "d = os.getenv('GETENV_ONE', 'default')",
      'e = os.getenv( "SPACED" )',
    ].join('\n');
    const refs = scanSource(src, 'python', 'app.py');
    expect(refs.map((r) => [r.name, r.syntax])).toEqual([
      ['DOUBLE', 'os.environ'],
      ['SINGLE', 'os.environ'],
      ['GET_ONE', 'os.environ'],
      ['GETENV_ONE', 'os.getenv'],
      ['SPACED', 'os.getenv'],
    ]);
  });

  it('ignores dynamic keys', () => {
    expect(names('os.environ[key]\nos.getenv(name)\nos.getenv(f"X_{y}")', 'python')).toEqual([]);
  });
});

describe('scanSource: Go', () => {
  it('detects os.Getenv and os.LookupEnv with double quotes or backticks', () => {
    const src = 'url := os.Getenv("DATABASE_URL")\nv, ok := os.LookupEnv(`TOKEN`)';
    const refs = scanSource(src, 'go', 'main.go');
    expect(refs.map((r) => [r.name, r.syntax, r.column])).toEqual([
      ['DATABASE_URL', 'os.Getenv', 8],
      ['TOKEN', 'os.LookupEnv', 10],
    ]);
  });

  it('ignores single quotes (runes) and variables', () => {
    expect(names("os.Getenv('X')\nos.Getenv(key)", 'go')).toEqual([]);
  });
});

describe('scanSource: Ruby', () => {
  it('detects ENV[...] and ENV.fetch with or without parentheses', () => {
    const src = [
      'ENV["DOUBLE"]',
      "ENV['SINGLE']",
      'ENV.fetch("FETCHED")',
      "ENV.fetch('WITH_DEFAULT', 'x')",
      'ENV.fetch "NO_PARENS"',
      '::ENV["ROOTED"]',
    ].join('\n');
    expect(names(src, 'ruby')).toEqual(['DOUBLE', 'SINGLE', 'FETCHED', 'WITH_DEFAULT', 'NO_PARENS', 'ROOTED']);
  });

  it('ignores look-alikes', () => {
    expect(names('MY_ENV["NOPE"]\nENV[key]', 'ruby')).toEqual([]);
  });
});

/** Name → whether the code supplies an inline default, for each reference in order. */
const defaults = (source: string, language: Language) =>
  scanSource(source, language, 'f').map((r) => [r.name, r.hasDefault === true] as const);

describe('scanSource: inline defaults (the reference is optional, never MISSING)', () => {
  it('JavaScript: `?? …` and `|| …` on the same line, for every access form', () => {
    const src = [
      "const a = process.env.WITH_NULLISH ?? 'x';",
      'const b = process.env.WITH_OR || 3000;',
      "const c = process.env['BRACKET'] ?? 'x';",
      "const d = import.meta.env.VITE_DEFAULTED || '/api';",
      'process.env.ASSIGNED ??= "x";',
      'const e = process.env.PLAIN;',
      "const f = process.env.COMPARED === 'on' || false;",
      'const g = process.env.CHAINED?.trim() ?? "x";',
      'const h = process.env.NEXT_LINE',
      '  ?? "x";',
      'const i = process.env.NORMALIZED || undefined;',
      'const j = process.env.NULLED ?? null;',
    ].join('\n');
    expect(defaults(src, 'javascript')).toEqual([
      ['WITH_NULLISH', true],
      ['WITH_OR', true],
      ['BRACKET', true],
      ['VITE_DEFAULTED', true],
      ['ASSIGNED', true],
      ['PLAIN', false],
      ['COMPARED', false],
      ['CHAINED', false],
      ['NEXT_LINE', false],
      ['NORMALIZED', false], // || undefined only turns "" into undefined: no default
      ['NULLED', false],
    ]);
  });

  it('marks only the reference that has the default when several share a line', () => {
    expect(defaults("const x = process.env.A || process.env.B || 'x';", 'javascript')).toEqual([
      ['A', true],
      ['B', true],
    ]);
    expect(defaults('f(process.env.A, process.env.B ?? 1)', 'javascript')).toEqual([
      ['A', false],
      ['B', true],
    ]);
  });

  it('Python: a second argument to os.getenv / os.environ.get, or `or …` after the call', () => {
    const src = [
      'a = os.getenv("GETENV_DEFAULT", "x")',
      "b = os.environ.get('GET_DEFAULT', default='x')",
      'c = os.getenv("GETENV_OR") or "x"',
      'd = os.environ.get("GET_OR") or 8000',
      'e = os.getenv("GETENV_PLAIN")',
      'f = os.environ.get("GET_PLAIN")',
      'g = os.environ["INDEXED"]',
      'h = os.environ["INDEXED_OR"] or "x"',
      'i = os.getenv("NONE_DEFAULT", None)',
      'j = os.environ.get("OR_NONE") or None',
    ].join('\n');
    expect(defaults(src, 'python')).toEqual([
      ['GETENV_DEFAULT', true],
      ['GET_DEFAULT', true],
      ['GETENV_OR', true],
      ['GET_OR', true],
      ['GETENV_PLAIN', false],
      ['GET_PLAIN', false],
      ['INDEXED', false], // os.environ[...] raises KeyError when unset
      ['INDEXED_OR', false],
      ['NONE_DEFAULT', false], // the same as os.getenv("NONE_DEFAULT")
      ['OR_NONE', false],
    ]);
  });

  it('Ruby: ENV.fetch with a default or a block, and ENV[...] || …', () => {
    const src = [
      'a = ENV.fetch("FETCH_DEFAULT", "x")',
      "b = ENV.fetch 'FETCH_NO_PARENS', 'x'",
      'c = ENV.fetch("FETCH_BLOCK") { "x" }',
      'd = ENV.fetch("FETCH_DO") do |k|',
      'e = ENV["INDEX_OR"] || "x"',
      'f = ENV.fetch("FETCH_PLAIN")',
      'g = ENV["INDEX_PLAIN"]',
      'h = ENV.fetch("FETCH_OR") || "x"',
      'i = ENV.fetch("FETCH_NIL", nil)',
      'j = ENV["INDEX_NIL"] || nil',
    ].join('\n');
    expect(defaults(src, 'ruby')).toEqual([
      ['FETCH_DEFAULT', true],
      ['FETCH_NO_PARENS', true],
      ['FETCH_BLOCK', true],
      ['FETCH_DO', true],
      ['INDEX_OR', true],
      ['FETCH_PLAIN', false],
      ['INDEX_PLAIN', false],
      ['FETCH_OR', false], // ENV.fetch without a default raises KeyError before || runs
      ['FETCH_NIL', false], // the same as ENV["FETCH_NIL"]
      ['INDEX_NIL', false],
    ]);
  });

  it('Go has no inline default form', () => {
    expect(defaults('a := os.Getenv("A")\nif a == "" { a = "x" }\nb, ok := os.LookupEnv("B")', 'go')).toEqual([
      ['A', false],
      ['B', false],
    ]);
  });

  it('leaves hasDefault off entirely when there is none (the stored shape is unchanged)', () => {
    expect(scanSource('process.env.A', 'javascript', 'f')[0]).not.toHaveProperty('hasDefault');
  });
});

describe('scanSource: one reference per variable per line', () => {
  it('merges repeated reads on a line into the leftmost one, in every language', () => {
    const js = scanSource('const a = process.env.DUP ? process.env.DUP : process.env["DUP"];\nprocess.env.DUP', 'javascript', 'f');
    expect(js).toEqual([
      { name: 'DUP', file: 'f', line: 1, column: 11, syntax: 'process.env' },
      { name: 'DUP', file: 'f', line: 2, column: 1, syntax: 'process.env' },
    ]);
    expect(scanSource('x = os.environ.get("DUP") or os.environ["DUP"]', 'python', 'f')).toHaveLength(1);
    expect(scanSource('v := os.Getenv("DUP") + os.Getenv("DUP")', 'go', 'f')).toHaveLength(1);
    expect(scanSource('ENV["DUP"] + ENV.fetch("DUP")', 'ruby', 'f')).toHaveLength(1);
    // Different variables on one line stay separate.
    expect(names('f(process.env.A, process.env.B, process.env.A)', 'javascript')).toEqual(['A', 'B']);
  });

  it('keeps a default only when every read on the line has one', () => {
    expect(scanSource('const a = process.env.DUP ?? process.env.DUP ?? "x"', 'javascript', 'f')[0]).toMatchObject({ hasDefault: true });
    // The first read has no default of its own: the line can still fail without it.
    expect(scanSource('const a = process.env.DUP; const b = process.env.DUP ?? "x"', 'javascript', 'f')[0]).not.toHaveProperty('hasDefault');
    expect(scanSource('const a = process.env.DUP ?? "x"; const b = process.env.DUP', 'javascript', 'f')[0]).not.toHaveProperty('hasDefault');
  });
});

describe('scanSource: a quoted reference is a string, not a read', () => {
  it('skips bundler define keys and messages, but still reads the value side and template literals', () => {
    const source = [
      "define: { 'process.env.EMBED_URL': JSON.stringify(process.env.EMBED_URL), \"process.env.ONLY_A_KEY\": '1' },",
      'throw new Error(`process.env.IN_A_MESSAGE`);',
      'const url = `${process.env.IN_A_TEMPLATE}/api`;',
      'const k = "import.meta.env.VITE_KEY_ONLY";',
    ].join('\n');
    expect(names(source, 'javascript')).toEqual(['EMBED_URL', 'IN_A_TEMPLATE']);
    expect(scanSource(source, 'javascript', 'f')[0]).toMatchObject({ name: 'EMBED_URL', column: 51 });
  });
});

describe('scanSource: same-line destructuring', () => {
  it('reads each key of { … } = process.env or import.meta.env, renamed or not, with its column', () => {
    const source = [
      'const { API_KEY, SITE_NAME: siteName } = process.env;',
      "let { 'QUOTED_KEY': q } = process.env",
      'const { VITE_API_URL }: ImportMetaEnv = import.meta.env;',
      'function start({ PORT } = process.env) {}',
    ].join('\n');
    expect(scanSource(source, 'javascript', 'f')).toEqual([
      { name: 'API_KEY', file: 'f', line: 1, column: 9, syntax: 'process.env' },
      { name: 'SITE_NAME', file: 'f', line: 1, column: 18, syntax: 'process.env' },
      { name: 'QUOTED_KEY', file: 'f', line: 2, column: 8, syntax: 'process.env' },
      { name: 'VITE_API_URL', file: 'f', line: 3, column: 9, syntax: 'import.meta.env' },
      { name: 'PORT', file: 'f', line: 4, column: 18, syntax: 'process.env' },
    ]);
  });

  it('counts a key with a default as optional; undefined and null are no default', () => {
    const refs = scanSource('const { A: a, B = "x", C: c = 3, D = undefined, E = null, F = f(1, 2) } = process.env;', 'javascript', 'f');
    expect(refs.map((r) => `${r.name}${r.hasDefault ? '?' : ''}`)).toEqual(['A', 'B?', 'C?', 'D', 'E', 'F?']);
  });

  it('skips rest elements, nested patterns, destructuring of one variable, and multi-line patterns', () => {
    const source = [
      'const { ONE, ...rest } = process.env;',
      'const { length } = process.env.SOME_VALUE;',
      'const { a: { b } } = process.env;',
      'const {',
      '  SPLIT_ACROSS_LINES,',
      '} = process.env;',
    ].join('\n');
    expect(names(source, 'javascript')).toEqual(['ONE', 'SOME_VALUE']);
  });

  it('merges with a direct read of the same variable on the line', () => {
    expect(scanSource('const { DUP } = process.env, again = process.env.DUP ?? "x";', 'javascript', 'f')).toEqual([
      { name: 'DUP', file: 'f', line: 1, column: 9, syntax: 'process.env' },
    ]);
  });
});

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
      'const { DESTRUCTURED } = process.env',
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

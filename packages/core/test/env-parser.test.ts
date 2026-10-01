import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/env-parser';

const keys = (source: string) => parseEnv(source).entries.map((e) => e.key);
const valueOf = (source: string, key: string) =>
  parseEnv(source).entries.find((e) => e.key === key)?.value;

describe('parseEnv', () => {
  it('parses simple assignments with line numbers', () => {
    const { entries } = parseEnv('A=1\nB=two\n\nC=3');
    expect(entries).toEqual([
      { key: 'A', value: '1', line: 1 },
      { key: 'B', value: 'two', line: 2 },
      { key: 'C', value: '3', line: 4 },
    ]);
  });

  it('skips blank lines and full-line comments', () => {
    expect(keys('# comment\n   # indented comment\n\nA=1\n')).toEqual(['A']);
  });

  it('accepts the export prefix and whitespace around =', () => {
    const src = 'export A=1\n  B = 2\nexport   C=3';
    expect(keys(src)).toEqual(['A', 'B', 'C']);
    expect(valueOf(src, 'B')).toBe('2');
  });

  it('treats an empty value as defined', () => {
    expect(parseEnv('EMPTY=\nALSO_EMPTY=""').entries).toEqual([
      { key: 'EMPTY', value: '', line: 1 },
      { key: 'ALSO_EMPTY', value: '', line: 2 },
    ]);
  });

  it('allows dots and dashes in keys', () => {
    expect(keys('app.name=x\nsome-key=y')).toEqual(['app.name', 'some-key']);
  });

  it('strips inline comments only when preceded by whitespace', () => {
    const src = 'A=value # comment\nB=http://host/#anchor\nC=#fff\nD=x#y';
    expect(valueOf(src, 'A')).toBe('value');
    expect(valueOf(src, 'B')).toBe('http://host/#anchor');
    expect(valueOf(src, 'C')).toBe('');
    expect(valueOf(src, 'D')).toBe('x#y');
  });

  it('keeps # inside quoted values', () => {
    expect(valueOf('A="has # hash" # real comment', 'A')).toBe('has # hash');
    expect(valueOf("B='# not a comment'", 'B')).toBe('# not a comment');
  });

  it('expands escapes only in double quotes', () => {
    expect(valueOf('A="line1\\nline2\\t\\"q\\""', 'A')).toBe('line1\nline2\t"q"');
    expect(valueOf("B='raw\\nvalue'", 'B')).toBe('raw\\nvalue');
    expect(valueOf('C=`back\\ntick`', 'C')).toBe('back\\ntick');
  });

  it('supports multi-line quoted values and keeps counting lines correctly', () => {
    const src = [
      'BEFORE=1',
      'CERT="-----BEGIN-----',
      'abc',
      'NOT_A_KEY=inside',
      '-----END-----"',
      'AFTER=2',
    ].join('\n');
    const { entries } = parseEnv(src);
    expect(entries.map((e) => [e.key, e.line])).toEqual([
      ['BEFORE', 1],
      ['CERT', 2],
      ['AFTER', 6],
    ]);
    expect(entries[1]?.value).toBe('-----BEGIN-----\nabc\nNOT_A_KEY=inside\n-----END-----');
  });

  it('treats an unterminated quote as a literal value and keeps parsing', () => {
    const { entries } = parseEnv('A="oops\nB=2');
    expect(entries).toEqual([
      { key: 'A', value: '"oops', line: 1 },
      { key: 'B', value: '2', line: 2 },
    ]);
  });

  it('handles CRLF line endings and a UTF-8 BOM', () => {
    expect(parseEnv('﻿A=1\r\nB=2\r\n').entries).toEqual([
      { key: 'A', value: '1', line: 1 },
      { key: 'B', value: '2', line: 2 },
    ]);
  });

  it('returns duplicate keys so callers can choose', () => {
    expect(parseEnv('A=1\nA=2').entries.map((e) => e.value)).toEqual(['1', '2']);
  });

  it('reports lines that are not assignments', () => {
    const { entries, invalid } = parseEnv('A=1\nthis is junk\n1BAD=x\nB=2');
    expect(entries.map((e) => e.key)).toEqual(['A', 'B']);
    expect(invalid).toEqual([
      { line: 2, text: 'this is junk' },
      { line: 3, text: '1BAD=x' },
    ]);
  });
});

describe('parseEnv: commented-out assignments', () => {
  it('lists the keys of commented-out KEY= lines, never prose', () => {
    const { entries, commented } = parseEnv('A=1\n# B=\n##  export C=x\n  # D = 2\n# Note: set A=1 first\n# e.g. F=1\n#G-H=1\n');
    expect(entries.map((e) => e.key)).toEqual(['A']);
    expect(commented).toEqual([
      { key: 'B', line: 2 },
      { key: 'C', line: 3 },
      { key: 'D', line: 4 },
    ]);
  });
});

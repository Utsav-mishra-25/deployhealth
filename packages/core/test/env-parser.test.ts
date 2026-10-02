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

  // Values that look like key material are assembled at run time.
  const base64Line = () => Array.from({ length: 64 }, (_, i) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[(i * 7 + 3) % 62]).join('');
  const dashes = '-'.repeat(5);

  it('reads the rest of the file as the value of a quote that never closes, and stops there', () => {
    const result = parseEnv(`KEY="abc\n${base64Line()}=\nOTHER=1\n`);
    expect(result.entries.map((e) => e.key)).toEqual(['KEY']);
    expect(result.entries[0]!.value).toBe(`abc\n${base64Line()}=\nOTHER=1\n`);
    expect(result.unterminated).toEqual({ line: 1, kind: 'quote' });
    expect(result.invalid).toEqual([]);
  });

  it('keeps parsing after a multi-line quote that does close', () => {
    const result = parseEnv(`KEY="abc\n${base64Line()}="\nOTHER=1\n`);
    expect(result.entries.map((e) => e.key)).toEqual(['KEY', 'OTHER']);
    expect(result.unterminated).toBeNull();
  });

  it('skips an unquoted PEM block, on its own or as a value, through its END line', () => {
    const block = [`${dashes}BEGIN PRIVATE KEY${dashes}`, `${base64Line()}=`, `${base64Line()}==`, `${dashes}END PRIVATE KEY${dashes}`];
    const asValue = parseEnv(['A=1', `PRIVATE_KEY=${block[0]}`, ...block.slice(1), 'B=2'].join('\n'));
    expect(asValue.entries).toEqual([
      { key: 'A', value: '1', line: 1 },
      { key: 'PRIVATE_KEY', value: block[0], line: 2 },
      { key: 'B', value: '2', line: 6 },
    ]);
    expect(asValue.invalid).toEqual([]);
    const bare = parseEnv(['A=1', ...block, 'B=2'].join('\n'));
    expect(bare.entries.map((e) => e.key)).toEqual(['A', 'B']);
    expect(bare.unterminated).toBeNull();
  });

  it('skips the rest of the file after a PEM block with no END line', () => {
    const result = parseEnv(['A=1', `K=${dashes}BEGIN RSA PRIVATE KEY${dashes}`, `${base64Line()}=`, 'B=2'].join('\n'));
    expect(result.entries.map((e) => e.key)).toEqual(['A', 'K']);
    expect(result.unterminated).toEqual({ line: 2, kind: 'block' });
  });

  it('reads a quote that never closes over 50,000 lines in linear time', () => {
    const started = performance.now();
    const result = parseEnv(`KEY="abc\n${'x\n'.repeat(50_000)}`);
    expect(result.entries).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
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

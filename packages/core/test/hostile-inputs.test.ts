import { describe, expect, it } from 'vitest';
import { scanFiles } from '../src/scan';
import { scanSource } from '../src/scanner';

// Every parser of untrusted input gets a timing test: a pull request (via the GitHub App) or a
// cloned repository (via the CLI) controls these files. Inputs are built at run time; the bounds
// are generous for CI, and each is far below what a quadratic or recursive version takes.
const ENV = ['process', 'env'].join('.');

async function timed<T>(fn: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

describe('scanner timing on hostile inputs', () => {
  it('scans 512 KB of repeated reads of one variable in under 2 s', async () => {
    const line = `${ENV}.A\n`;
    const source = line.repeat(Math.floor((512 * 1024) / line.length));
    const { value, ms } = await timed(() => scanFiles(new Map([['src/a.ts', source], ['.env.example', '']])));
    expect(value.references).toHaveLength(source.split('\n').length - 1);
    expect(value.variables).toEqual([{ var_name: 'A', scope: '', defined_in: [] }]);
    expect(ms).toBeLessThan(2_000);
  });

  it('resolves 8,000 chained pydantic-settings classes, defined in reverse order, in under 2 s without recursion', async () => {
    const n = 8_000;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(`class C${i}(${i === n - 1 ? 'BaseSettings' : `C${i + 1}`}):\n    f${i}: str\n`);
    parts.push(`class C${n - 1}Config:\n    pass\n`);
    const { value, ms } = await timed(() => scanSource(parts.join('\n'), 'python', 'settings.py'));
    expect(value).toHaveLength(n);
    expect(value[0]).toMatchObject({ name: 'F0', line: 2 });
    expect(value.some((r) => r.hasDefault)).toBe(false);
    expect(ms).toBeLessThan(2_000);
  });

  it('inherits an env_prefix down a long chain, memoised', async () => {
    const n = 5_000;
    const parts = [`class Root(BaseSettings):\n    model_config = SettingsConfigDict(env_prefix="APP_")\n    root: str\n`];
    for (let i = 0; i < n; i++) parts.push(`class D${i}(${i === 0 ? 'Root' : `D${i - 1}`}):\n    d${i}: str\n`);
    const { value, ms } = await timed(() => scanSource(parts.join('\n'), 'python', 'settings.py'));
    expect(value).toHaveLength(n + 1);
    expect(value.every((r) => r.name.startsWith('APP_'))).toBe(true);
    expect(ms).toBeLessThan(2_000);
  });

  it('survives deeply nested classes (one stack pass, no per-class body copies)', async () => {
    const depth = 3_000;
    const lines = ['class Top(BaseSettings):', '    top: str'];
    for (let i = 0; i < depth; i++) lines.push(`${'    '.repeat(i + 1)}class N${i}:`, `${'    '.repeat(i + 2)}n${i}: int = 1`);
    const { value, ms } = await timed(() => scanSource(lines.join('\n'), 'python', 'settings.py'));
    expect(value.map((r) => r.name)).toEqual(['TOP']);
    expect(ms).toBeLessThan(2_000);
  });

  it('reads one line destructuring 150,000 keys from process.env in under 3 s', async () => {
    const keys = Array.from({ length: 150_000 }, (_, i) => `K${i}`);
    const source = `const { ${keys.join(', ')} } = ${ENV};\n`;
    const { value, ms } = await timed(() => scanSource(source, 'javascript', 'src/a.ts'));
    expect(value).toHaveLength(keys.length);
    expect(ms).toBeLessThan(3_000);
  });

  it('scans a file under the 512 KB limit that destructures one key 200,000 times', async () => {
    const source = `const {${'A,'.repeat(200_000)}} = ${ENV};\n`;
    expect(Buffer.byteLength(source)).toBeLessThan(512 * 1024);
    const { value, ms } = await timed(() => scanFiles(new Map([['src/a.ts', source], ['.env.example', '']])));
    expect(value.references).toHaveLength(1);
    expect(value.counts.missing).toBe(1);
    expect(ms).toBeLessThan(3_000);
  });
});

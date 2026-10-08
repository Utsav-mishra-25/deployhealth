import { describe, expect, it } from 'vitest';
import { scanFiles, selectTreeFiles } from '../src/scan';
import { scanSource } from '../src/scanner';
import { MAX_SOURCE_FILE_BYTES } from '../src/vendored';

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

  it('resolves 650 nested settings classes, each inheriting from the one around it, in under 1 s', async () => {
    // Each class re-reads its ancestors' prefixes over their whole bodies unless prefixes are
    // memoised and bodies precomputed: about 5.6 s before 4.8, under 0.1 s now. One-space indents
    // keep the file under the 512 KB source limit (430 KB), so the App would fetch and scan it.
    const depth = 650;
    const lines: string[] = [];
    for (let i = 0; i < depth; i++) lines.push(`${' '.repeat(i)}class N${i}(${i === 0 ? 'BaseSettings' : `N${i - 1}`}):`, `${' '.repeat(i + 1)}n${i}: str`);
    const source = `${lines.join('\n')}\n`;
    expect(Buffer.byteLength(source)).toBeLessThan(512 * 1024);
    const { value, ms } = await timed(() => scanSource(source, 'python', 'settings.py'));
    expect(value).toHaveLength(depth);
    expect(value[0]).toMatchObject({ name: 'N0', line: 2 });
    expect(ms).toBeLessThan(1_000);
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

  it('warns once, with file:line only, when a quote in an env file never closes', async () => {
    const secretish = Array.from({ length: 40 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
    const result = await scanFiles(new Map([['.env', `KEY="${secretish}\n${secretish}=\nOTHER=1\n`], ['src/a.ts', `${ENV}.KEY`]]));
    expect(result.warnings).toEqual([{ file: '.env', line: 1, message: 'a quote that never closes: the rest of the file was read as this value' }]);
    expect(JSON.stringify(result)).not.toContain(secretish);
  });
});

// PHP and Symfony (Phase 5). Each input is one line just under the 512 KB source limit, the worst
// case for patterns that run line by line. The bounds leave ~4x headroom over GitHub's runners;
// the comment on each gives the time here and what a quadratic version took.
describe('PHP and Symfony timing on hostile inputs', () => {
  const LIMIT = 512 * 1024 - 64;
  const oneLine = (unit: string, tail = '') => `${unit.repeat(Math.floor((LIMIT - tail.length) / unit.length))}${tail}`;

  it("reads one line of 37,000 env('A', 'x') calls, each checked for a default, in under 1 s", async () => {
    // ~35 ms here. Testing for a default with an unanchored pattern over the rest of the line (a
    // plausible slip) took 24 s.
    const source = oneLine("env('A', 'x') . ");
    const { value, ms } = await timed(() => scanFiles(new Map([['config/a.php', source], ['.env.example', '']])));
    expect(value.references).toEqual([expect.objectContaining({ name: 'A', hasDefault: true })]);
    expect(ms).toBeLessThan(1_000);
  });

  it('reads one line of unclosed getenv, $_ENV, Env::get and $_SERVER reads in under 1 s', async () => {
    // ~20 ms here for all five: every attempt stops at the next quote or bracket.
    for (const unit of ["getenv('A' ", "$_ENV['A' ", "Env::get('A ", "$_SERVER['A' ", "getenv('A', x, "]) {
      const source = oneLine(unit);
      const { value, ms } = await timed(() => scanFiles(new Map([['a.php', source], ['.env.example', 'A=\n']])));
      expect(value.references, unit).toEqual([]);
      expect(ms, unit).toBeLessThan(1_000);
    }
  });

  it('reads one line of $_SERVER reads as one used name in under 1 s', async () => {
    const source = oneLine("$_SERVER['A'] . ");
    const { value, ms } = await timed(() => scanFiles(new Map([['a.php', source], ['.env.example', 'A=\n']])));
    expect(value.references).toEqual([]);
    expect(value.findings).toEqual([]);
    expect(ms).toBeLessThan(1_000);
  });

  it('reads Symfony placeholders that never close, with 250,000 processor segments, in under 1 s', async () => {
    // ~30 ms here. Letting a processor segment contain ':' (nested quantifiers) didn't finish in 200 s.
    for (const source of [`a: '%env(${oneLine('a:', 'A')}`, oneLine('%env(int:A '), oneLine("%env(default:x:A)% "), `a: '%env(${oneLine('a')}`]) {
      const { value, ms } = await timed(() => scanFiles(new Map([['config/a.yaml', source], ['.env.example', '']])));
      expect(value.references.length).toBeLessThanOrEqual(1);
      expect(ms).toBeLessThan(1_000);
    }
  });
});

describe('path rules timing on hostile trees', () => {
  it('selects from 2,000 paths 400 directories deep (6.5 MB, about where GitHub truncates a tree), with an artisan at every level, in under 2 s', async () => {
    // Every directory holds an artisan, so the check follows each path to its last directory.
    // ~180 ms here; rebuilding the parent path for every directory took 9.4 s.
    const dirs = Array.from({ length: 400 }, () => 'app');
    const paths: string[] = [];
    for (let depth = 0; depth <= 400; depth++) paths.push(`${dirs.slice(0, depth).join('/')}${depth ? '/' : ''}artisan`);
    const deep = dirs.join('/');
    for (let i = paths.length; i < 1_999; i++) paths.push(`${deep}/f${i}.php`);
    paths.push(`${deep}/storage/compiled.php`);
    const { value, ms } = await timed(() => selectTreeFiles(paths));
    expect(value).toHaveLength(1_999);
    expect(value).not.toContain(`${deep}/storage/compiled.php`);
    expect(ms).toBeLessThan(2_000);
  });
});

// Java, Kotlin and Spring (Phase 5). The same ~4x headroom; the comment on each gives the time
// here and what a quadratic version took.
describe('Java, Kotlin and Spring timing on hostile inputs', () => {
  const LIMIT = 512 * 1024 - 64;
  const oneLine = (unit: string, tail = '') => `${unit.repeat(Math.floor((LIMIT - tail.length) / unit.length))}${tail}`;

  it('reads one Kotlin line of 26,000 System.getenv("A") reads, each checked for a default, in under 1 s', async () => {
    // ~50 ms here. Reads with no default are the worst case: an unanchored default check scans the
    // rest of the line for each, which took 6.5 s.
    const source = oneLine('System.getenv("A"); ');
    const { value, ms } = await timed(() => scanFiles(new Map([['src/A.kt', source], ['.env.example', '']])));
    expect(value.references).toEqual([expect.objectContaining({ name: 'A' })]);
    expect(value.references[0]!.hasDefault).toBeUndefined();
    expect(ms).toBeLessThan(1_000);
  });

  it('reads one line of unclosed System.getenv, map reads and @Value placeholders in under 1 s', async () => {
    // ~60 ms here for all of them: every attempt stops at the next quote, bracket or brace.
    for (const unit of ['System.getenv("A ', 'System.getenv().get("A ', 'System.getenv()["A" ', 'System.getenv().getOrDefault("A", ', '@Value("${A ', '${', '${A:']) {
      const source = oneLine(unit);
      const { value, ms } = await timed(() => scanFiles(new Map([['src/A.java', source], ['.env.example', 'A=\n']])));
      expect(value.references.length, unit).toBeLessThanOrEqual(1);
      expect(ms, unit).toBeLessThan(1_000);
    }
  });

  it('reads a Spring config line of 130,000 nested defaults (${A:${A:…) in under 1 s', async () => {
    // ~50 ms here: one pass with a stack of open placeholders.
    const source = `a=${oneLine('${A:', '}')}`;
    const { value, ms } = await timed(() => scanFiles(new Map([['application.properties', source], ['.env.example', '']])));
    expect(value.references).toEqual([expect.objectContaining({ name: 'A', hasDefault: true })]);
    expect(ms).toBeLessThan(1_000);
  });

  it('reads YAML with a 200 KB key over 15,000 children, and 900 levels of nesting, in under 1 s', async () => {
    // ~35 ms here: key paths past 256 characters aren't built. Joining every line's full key path
    // took 8 s.
    const wide = `${'k'.repeat(200 * 1024)}:\n${'  child: 1\n'.repeat(15_000)}`;
    const deep = Array.from({ length: 900 }, (_, i) => `${' '.repeat(i)}k${i}:`).join('\n');
    for (const source of [wide, deep]) {
      expect(Buffer.byteLength(source)).toBeLessThan(MAX_SOURCE_FILE_BYTES);
      const { ms } = await timed(() => scanFiles(new Map([['src/A.java', 'import org.springframework.boot.X;'], ['application.yml', source], ['.env.example', 'K_CHILD=\n']])));
      expect(ms).toBeLessThan(1_000);
    }
  });

  it('matches 50,000 declared names against 50,000 @ConfigurationProperties prefixes in under 2 s', async () => {
    // ~450 ms here: a character trie of prefixes. Checking every name against every prefix took
    // 64 s.
    const n = 50_000;
    const env = Array.from({ length: n }, (_, i) => `APP_P${i}_X=`).join('\n');
    // Ten files under the 512 KB source limit, 5,000 annotations each.
    const files = new Map([['.env.example', env]]);
    for (let f = 0; f < 10; f++) {
      const lines = Array.from({ length: n / 10 }, (_, i) => `@ConfigurationProperties("app.q${f * 10_000 + i}")`);
      files.set(`src/Props${f}.java`, `import org.springframework.boot.X;\n${lines.join('\n')}`);
      expect(Buffer.byteLength(files.get(`src/Props${f}.java`)!)).toBeLessThan(MAX_SOURCE_FILE_BYTES);
    }
    const { value, ms } = await timed(() => scanFiles(files));
    expect(value.counts.unused).toBe(n);
    expect(ms).toBeLessThan(2_000);
  });
});

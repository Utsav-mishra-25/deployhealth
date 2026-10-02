import { scanFiles } from '@deployhealth/core';
import { describe, expect, it } from 'vitest';
import { diffEnvVars } from '../src/pr-check/diff';
import { checkRunOutput, emptyReport, renderComment } from '../src/pr-check/report';

// The pull request check's own work on hostile inputs (scan both sides, diff, render), timed.
// Inputs are built at run time and stay within what the App would fetch (512 KB per file).
const ENV = ['process', 'env'].join('.');

async function check(head: Map<string, string>) {
  const started = performance.now();
  const diff = diffEnvVars(await scanFiles(new Map([['.env.example', '']])), await scanFiles(head));
  const report = { ...emptyReport(), ...diff };
  const comment = renderComment(report, { mode: 'comment', headSha: 'a'.repeat(40) });
  const output = checkRunOutput(report, 'neutral');
  return { diff, comment, output, ms: performance.now() - started };
}

describe('pull request check timing on hostile inputs', () => {
  it('diffs 512 KB of repeated reads of one variable in under 2 s', async () => {
    const line = `${ENV}.A\n`;
    const { diff, ms } = await check(new Map([['src/a.ts', line.repeat(Math.floor((512 * 1024) / line.length))], ['.env.example', '']]));
    expect(diff.added).toEqual([expect.objectContaining({ name: 'A', total: 37_449 })]);
    expect(ms).toBeLessThan(2_000);
  });

  // About 1.7 s alone, twice that when CI runs every package's tests at once; quadratic code took
  // minutes. The bound leaves room for a loaded runner.
  it('diffs 150,000 new variables read by destructuring (four files under 512 KB) in under 10 s', async () => {
    const head = new Map([['.env.example', '']]);
    for (let f = 0; f < 4; f++) {
      const keys = Array.from({ length: 37_500 }, (_, i) => `K${f}_${i}`).join(',');
      head.set(`src/f${f}.ts`, `const {${keys}} = ${ENV};\n`);
    }
    const { diff, comment, output, ms } = await check(head);
    expect(diff.added).toHaveLength(150_000);
    expect(diff.undeclared).toHaveLength(150_000);
    for (const text of [comment, output.summary, output.text!]) expect(text.length).toBeLessThan(65_535);
    expect(ms).toBeLessThan(10_000);
  });

  it('pairs renames through per-file indexes, not names × files', async () => {
    const files = 2_000;
    const base = new Map([['.env.example', '']]);
    const head = new Map([['.env.example', '']]);
    for (let f = 0; f < files; f++) {
      base.set(`src/f${f}.ts`, `${ENV}.OLD_${f}\n`);
      head.set(`src/f${f}.ts`, `${ENV}.NEW_${f}\n`);
    }
    const started = performance.now();
    const diff = diffEnvVars(await scanFiles(base), await scanFiles(head));
    expect(diff.renamed).toHaveLength(files);
    expect(diff.renamed[0]).toMatchObject({ from: 'OLD_0', to: 'NEW_0', file: 'src/f0.ts', line: 1 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

import { Worker } from 'node:worker_threads';
import type { DueEndpoint } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import tsupConfig from '../tsup.config';
import { checkEndpoints } from '../src/jobs';
import { MAX_REPORTED_ROWS, MAX_REPORTED_UNDECLARED, type AnalyzeInput } from '../src/pr-check/analysis';
import { ISOLATE_BUNDLE, isolateEntry, openPrCheckIsolate, UncheckableError } from '../src/pr-check/isolate';

const ENV = ['process', 'env'].join('.');

/** A real pull request's analysis that takes seconds: `files` × 37,500 new variables (each file under 512 KB). */
function heavyInput(files: number): AnalyzeInput {
  const head: Array<[string, string]> = [['.env.example', '']];
  for (let f = 0; f < files; f++) {
    head.push([`src/f${f}.ts`, `const {${Array.from({ length: 37_500 }, (_, i) => `K${f}_${i}`).join(',')}} = ${ENV};\n`]);
  }
  return { base: [], head, baseTree: [], headTree: [], pullFiles: [] };
}

/** The main event loop's worst delay while `during` runs, sampled every 10 ms. */
async function maxLoopLag<T>(during: Promise<T>): Promise<{ lag: number; result: PromiseSettledResult<T> }> {
  let lag = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 10);
    last = now;
  }, 10);
  const [result] = await Promise.allSettled([during]);
  clearInterval(timer);
  return { lag, result };
}

describe('the pull request check isolate', () => {
  it('loads a fixed entry: dist/pr-check-isolate.js next to the bundled index.js, which tsup builds', () => {
    const bundled = isolateEntry('file:///app/apps/worker/dist/index.js');
    expect(bundled.file.href).toBe('file:///app/apps/worker/dist/pr-check-isolate.js');
    expect(bundled.worker).toEqual([bundled.file, {}]);
    const entry = (tsupConfig as { entry: Record<string, string> }).entry;
    expect(entry).toEqual({ index: 'src/index.ts', [ISOLATE_BUNDLE]: 'src/pr-check/isolate-worker.ts' });
    // From source, the same file next to this module, through a bootstrap that only registers tsx.
    const source = isolateEntry('file:///repo/apps/worker/src/pr-check/isolate.ts');
    expect(source.file.href).toBe('file:///repo/apps/worker/src/pr-check/isolate-worker.ts');
    expect(source.worker[1]).toEqual({ eval: true });
  });

  it('chooses files and analyzes them in the thread', async () => {
    const isolate = await openPrCheckIsolate();
    try {
      const head = [
        { path: 'src/a.ts', sha: 'a', size: 10 },
        { path: 'node_modules/x.ts', sha: 'b', size: 1 },
        { path: '.env.example', sha: 'c', size: 0 },
      ];
      const chosen = await isolate.run('select', { base: [], head });
      expect(chosen).toMatchObject({ base: [], head: ['.env.example', 'src/a.ts'], coverage: { sourceFiles: 1, readFiles: 2, changedRead: 2 } });
      const analysis = await isolate.run('analyze', { base: [], head: [['src/a.ts', `${ENV}.API_KEY`], ['.env.example', '']], baseTree: [], headTree: [], pullFiles: [] });
      expect(analysis.undeclared).toEqual(['API_KEY']);
    } finally {
      await isolate.close();
    }
  });

  it('stops work that runs past its time limit, and stays stopped', async () => {
    const isolate = await openPrCheckIsolate({ limitMs: 100 });
    const started = performance.now();
    const error = await isolate.run('analyze', heavyInput(4)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UncheckableError);
    expect((error as UncheckableError).reason).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(600);
    await expect(isolate.run('select', { base: [], head: [] })).rejects.toBeInstanceOf(UncheckableError);
    await isolate.close();
  });

  it('hands back bounded lists with exact totals, so even a huge result never stalls the event loop', async () => {
    const isolate = await openPrCheckIsolate();
    try {
      const { lag, result } = await maxLoopLag(isolate.run('analyze', heavyInput(8)));
      expect(result.status).toBe('fulfilled');
      const analysis = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof isolate.run<'analyze'>>>>).value;
      expect(analysis.added).toHaveLength(MAX_REPORTED_ROWS);
      expect(analysis.undeclared).toHaveLength(MAX_REPORTED_UNDECLARED);
      expect(analysis.counts).toMatchObject({ added: 300_000, addedUndeclared: 300_000, undeclared: 300_000 });
      expect(lag).toBeLessThan(100);
    } finally {
      await isolate.close();
    }
    // About 2.7 s alone and 8 s on a loaded CI runner, so 60 s rather than the 20 s default.
  }, 60_000);

  it('relies on terminate() stopping a thread mid-loop, even inside a backtracking regex', async () => {
    for (const code of ['for (;;) {}', "/^(a+)+$/.test('a'.repeat(40) + 'b')"]) {
      const worker = new Worker(`require('node:worker_threads').parentPort.postMessage('go'); ${code}`, { eval: true });
      await new Promise((resolve) => worker.once('message', resolve));
      const started = performance.now();
      await worker.terminate();
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it('never delays the event loop or check-endpoints while a check runs out its limit', async () => {
    // A real check (8 × 37,500 new variables: seconds of work) with a 1 s limit, and alongside it a
    // check-endpoints run on real timers with three waves 100 ms apart.
    const isolate = await openPrCheckIsolate({ limitMs: 1_000 });
    const t0 = Date.now() + 100;
    const due = [0, 100, 200].map((offset, i) => ({ id: `e${i}`, runAt: new Date(t0 + offset) }) as unknown as DueEndpoint);
    const late: number[] = [];
    const endpointsRun = checkEndpoints({
      claimDue: async () => due,
      check: async (target) => {
        late.push(Date.now() - (target as unknown as DueEndpoint).runAt.getTime());
        return { checkedAt: new Date(), statusCode: 200, latencyMs: 1, ok: true, error: null };
      },
      record: async () => ({ consecutiveFailures: 0, event: null }),
      notify: async () => true,
      heartbeat: async () => {},
      log: () => {},
    });
    const started = performance.now();
    const { lag, result } = await maxLoopLag(Promise.all([isolate.run('analyze', heavyInput(8)), endpointsRun]));
    await isolate.close();

    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(UncheckableError);
    expect(performance.now() - started).toBeLessThan(1_500); // terminated within limit + 500 ms
    expect(await endpointsRun).toMatchObject({ checked: 3, errors: 0 });
    expect(late).toHaveLength(3);
    expect(Math.max(...late)).toBeLessThan(250); // each wave starts within 250 ms of its time
    expect(lag).toBeLessThan(100); // the main event loop never stalls for 100 ms
  });
});

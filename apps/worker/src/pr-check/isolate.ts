import { PR_CHECK_TIME_LIMIT_MS } from '@deployhealth/core';
import { Worker } from 'node:worker_threads';
import type { AnalyzeInput, Analysis, SelectInput } from './analysis';

/**
 * The pull request check's CPU work (tree selection, scanning, diff, secret search) runs here, in
 * a worker thread, so a hostile pull request can never block the worker's event loop: uptime
 * checks and alerts keep running whatever it holds. The thread gets only data already downloaded
 * and makes no network calls, so anything that goes wrong inside it (the time limit, a thrown
 * error, running out of memory) is the pull request's input, never GitHub's or the network's:
 * that's an UncheckableError, which the job reports once instead of retrying.
 */

/** The thread's heap cap: well above a check at the 20 MB fetch cap, far below the process's. */
export const PR_CHECK_HEAP_MB = 512;

/** The bundle tsup builds from isolate-worker.ts, next to dist/index.js (tsup.config.ts). */
export const ISOLATE_BUNDLE = 'pr-check-isolate';

export type UncheckableReason = 'timeout' | 'failed' | 'crashed';

/** The isolate couldn't finish this pull request's input. Safe to show: a fixed message. */
export class UncheckableError extends Error {
  constructor(readonly reason: UncheckableReason) {
    super(`pull request could not be checked (${reason})`);
    this.name = 'UncheckableError';
  }
}

interface Tasks {
  select: { input: SelectInput; output: { base: string[]; head: string[] } };
  analyze: { input: AnalyzeInput; output: Analysis };
}

export interface PrCheckIsolate {
  run<K extends keyof Tasks>(task: K, input: Tasks[K]['input']): Promise<Tasks[K]['output']>;
  close(): Promise<void>;
}

/**
 * The entry file is fixed: the bundled `dist/pr-check-isolate.js` next to `dist/index.js` (this
 * module is bundled into index.js), or `isolate-worker.ts` next to this file when running from
 * source (dev, tests), loaded through a two-line bootstrap that registers tsx inside the thread
 * (a thread doesn't inherit the parent's loader). Nothing configures it.
 */
export function isolateEntry(moduleUrl: string = import.meta.url): { file: URL; worker: [URL | string, { eval?: boolean }] } {
  if (!moduleUrl.endsWith('.ts')) {
    const file = new URL(`./${ISOLATE_BUNDLE}.js`, moduleUrl);
    return { file, worker: [file, {}] };
  }
  const file = new URL('./isolate-worker.ts', moduleUrl);
  const bootstrap = `import('tsx/esm/api').then((tsx) => { tsx.register(); return import(${JSON.stringify(file.href)}); });`;
  return { file, worker: [bootstrap, { eval: true }] };
}

/**
 * Start a thread for one pull request check. Resolves once the thread has loaded and said so; a
 * thread that fails to start (say, a missing entry file) rejects with that error, which is not
 * an UncheckableError: it's this deployment's fault, so the job retries and logs it.
 *
 * `limitMs` is the total time the thread may spend working across every `run` (time between
 * runs, while the main thread downloads, doesn't count). When it runs out the thread is
 * terminated, mid-loop if need be, and the run rejects with UncheckableError('timeout').
 */
export async function openPrCheckIsolate({ limitMs = PR_CHECK_TIME_LIMIT_MS, heapMb = PR_CHECK_HEAP_MB } = {}): Promise<PrCheckIsolate> {
  const [source, options] = isolateEntry().worker;
  const worker = new Worker(source, { ...options, resourceLimits: { maxOldGenerationSizeMb: heapMb } });

  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: { ready?: boolean }) => {
      if (!message.ready) return;
      worker.off('error', onError).off('exit', onExit).off('message', onMessage);
      resolve();
    };
    const onError = (error: Error) => {
      worker.off('exit', onExit).off('message', onMessage);
      reject(error);
    };
    const onExit = (code: number) => {
      worker.off('error', onError).off('message', onMessage);
      reject(Object.assign(new Error(`pr-check isolate exited with code ${code} before it was ready`), { code: 'ERR_ISOLATE_START' }));
    };
    worker.on('message', onMessage).once('error', onError).once('exit', onExit);
  });

  let remaining = limitMs;
  let nextId = 0;
  let dead: UncheckableError | null = null;

  return {
    run(task, input) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      const started = performance.now();
      return new Promise((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          remaining -= performance.now() - started;
          worker.off('message', onMessage).off('error', onError).off('exit', onExit);
        };
        const fail = (reason: UncheckableReason) => {
          done();
          dead = new UncheckableError(reason);
          void worker.terminate();
          reject(dead);
        };
        const onMessage = (message: { id: number; ok: boolean; output?: unknown }) => {
          if (message.id !== id) return;
          if (!message.ok) return fail('failed');
          done();
          resolve(message.output as never);
        };
        const onError = () => fail('crashed'); // out of memory, or an error outside the handler
        const onExit = () => fail('crashed');
        const timer = setTimeout(() => fail('timeout'), Math.max(0, remaining));
        worker.on('message', onMessage).once('error', onError).once('exit', onExit);
        worker.postMessage({ id, task, input });
      });
    },
    async close() {
      await worker.terminate();
    },
  };
}

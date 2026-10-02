import { createFetchBudget } from '@deployhealth/core';
import type { GithubApi, PullRequestInfo, TreeBlob } from '../github/api';
import { openPrCheckIsolate, type PrCheckIsolate } from './isolate';
import { emptyReport, type PrReport } from './report';

const DOWNLOAD_CONCURRENCY = 8;

export interface BuildOptions {
  budget?: ReturnType<typeof createFetchBudget>;
  /** Starts the isolate the CPU work runs in (isolate.ts). Tests pass a shorter time limit. */
  openIsolate?: () => Promise<PrCheckIsolate>;
}

/**
 * Read a pull request from GitHub and work out its report, within the hard caps: every file
 * scanned (each distinct path and blob of both trees, plus the pull request's patches) is
 * reserved against `budget` before anything is downloaded, so an oversized pull request is
 * refused before the bulk of the work. A file unchanged between base and head counts once; many
 * paths sharing one blob count once each, since each is scanned. Each distinct blob is still
 * downloaded once. Throws LimitExceededError when a cap is hit.
 *
 * Only GitHub calls happen here, on the main thread; choosing files and everything after the
 * downloads runs in the isolate, which throws UncheckableError when it can't finish.
 *
 * The outcome is decided from the tree listings, before any blob is downloaded: `cant-check`
 * when head holds no source file in a language the scanner reads, `nothing-changed` when the
 * pull request changes no file the check reads, else `checked`. The first two download no blobs.
 */
export async function buildReport(api: GithubApi, pr: PullRequestInfo, { budget = createFetchBudget(), openIsolate = openPrCheckIsolate }: BuildOptions = {}): Promise<PrReport> {
  const [baseTree, headTree] = await Promise.all([api.tree(pr.baseSha), api.tree(pr.headSha)]);
  if (baseTree.truncated || headTree.truncated) {
    return emptyReport('This repository has too many files for GitHub to list in one tree, so it was not checked.');
  }

  const isolate = await openIsolate();
  try {
    // Choose the files each side would scan. Tracked files are never gitignored, so no .gitignore is read.
    const strip = (blobs: readonly TreeBlob[]) => blobs.map(({ path, sha, size }) => ({ path, sha, size }));
    const chosen = await isolate.run('select', { base: strip(baseTree.blobs), head: strip(headTree.blobs) });
    const { coverage } = chosen;
    const tree = (blobs: readonly TreeBlob[]) => blobs.map(({ path, sha }) => ({ path, sha }));

    // No supported source file in head (can't check), or no file the check reads changed: no file
    // contents are needed. The checks that don't depend on a language still run: secrets on the
    // pull request's added lines, and committed env files from the tree paths.
    if (coverage.sourceFiles === 0 || coverage.changedRead === 0) {
      const pullFiles = await api.pullFiles(pr.number);
      for (const file of pullFiles) budget.take(Buffer.byteLength(file.patch ?? ''));
      const analysis = await isolate.run('analyze', { base: [], head: [], baseTree: tree(baseTree.blobs), headTree: tree(headTree.blobs), pullFiles });
      return { ...analysis, tooLarge: null, coverage, outcome: coverage.sourceFiles === 0 ? 'cant-check' : 'nothing-changed' };
    }

    const pick = (blobs: readonly TreeBlob[], paths: readonly string[]) => {
      const byPath = new Map(blobs.map((b) => [b.path, b]));
      return paths.map((path) => byPath.get(path)!);
    };
    const baseFiles = pick(baseTree.blobs, chosen.base);
    const headFiles = pick(headTree.blobs, chosen.head);

    const reserved = new Set<string>();
    /** Reservations per blob, so `verify` corrects the byte count once for each of them. */
    const copies = new Map<string, number>();
    const contents = new Map<string, Promise<string>>();
    const reserve = (blob: TreeBlob) => {
      const key = `${blob.path}\0${blob.sha}`;
      if (reserved.has(key)) return;
      budget.take(blob.size);
      reserved.add(key);
      copies.set(blob.sha, (copies.get(blob.sha) ?? 0) + 1);
    };
    const download = (blob: TreeBlob) => {
      let text = contents.get(blob.sha);
      if (!text) {
        text = api.blob(blob.sha).then((buffer) => {
          const n = copies.get(blob.sha) ?? 1;
          budget.verify(blob.size * n, buffer.length * n);
          return buffer.toString('utf8');
        });
        contents.set(blob.sha, text);
      }
      return text;
    };

    // The pull request's own diff, for secrets on added lines. Each file counts toward the caps.
    const pullFiles = await api.pullFiles(pr.number);
    for (const file of pullFiles) budget.take(Buffer.byteLength(file.patch ?? ''));

    // Reserve everything, then download (shared blobs once).
    for (const blob of baseFiles) reserve(blob);
    for (const blob of headFiles) reserve(blob);
    await forEachLimited([...new Map([...baseFiles, ...headFiles].map((b) => [b.sha, b])).values()], DOWNLOAD_CONCURRENCY, download);

    const read = async (files: readonly TreeBlob[]) => Promise.all(files.map(async (b) => [b.path, await download(b)] as const));
    const analysis = await isolate.run('analyze', {
      base: await read(baseFiles),
      head: await read(headFiles),
      baseTree: tree(baseTree.blobs),
      headTree: tree(headTree.blobs),
      pullFiles,
    });
    return { ...analysis, tooLarge: null, coverage, outcome: 'checked' };
  } finally {
    await isolate.close();
  }
}

async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

import { createFetchBudget, scanFiles, selectTreeFiles } from '@deployhealth/core';
import type { GithubApi, PullRequestInfo, TreeBlob } from '../github/api';
import { committedEnvFiles, diffEnvVars } from './diff';
import { emptyReport, type PrReport } from './report';
import { findSecrets } from './secrets';

const DOWNLOAD_CONCURRENCY = 8;

/**
 * Read a pull request from GitHub and work out its report, within the hard caps: every file
 * scanned (each distinct path and blob of both trees, plus the pull request's patches) is
 * reserved against `budget` before anything is downloaded, so an oversized pull request is
 * refused before the bulk of the work. A file unchanged between base and head counts once; many
 * paths sharing one blob count once each, since each is scanned. Each distinct blob is still
 * downloaded once. Throws LimitExceededError when a cap is hit.
 */
export async function buildReport(api: GithubApi, pr: PullRequestInfo, budget = createFetchBudget()): Promise<PrReport> {
  const [baseTree, headTree] = await Promise.all([api.tree(pr.baseSha), api.tree(pr.headSha)]);
  if (baseTree.truncated || headTree.truncated) {
    return emptyReport('This repository has too many files for GitHub to list in one tree, so it was not checked.');
  }

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

  // Choose the files each side would scan. Tracked files are never gitignored, so no .gitignore is read.
  const select = (blobs: readonly TreeBlob[]) => {
    const byPath = new Map(blobs.map((b) => [b.path, b]));
    const sizes = new Map(blobs.map((b) => [b.path, b.size]));
    return selectTreeFiles([...byPath.keys()], { sizes }).map((path) => byPath.get(path)!);
  };
  const baseFiles = select(baseTree.blobs);
  const headFiles = select(headTree.blobs);

  // The pull request's own diff, for secrets on added lines. Each file counts toward the caps.
  const pullFiles = await api.pullFiles(pr.number);
  for (const file of pullFiles) budget.take(Buffer.byteLength(file.patch ?? ''));

  // Reserve everything, then download (shared blobs once).
  for (const blob of [...baseFiles, ...headFiles]) reserve(blob);
  await forEachLimited([...new Map([...baseFiles, ...headFiles].map((b) => [b.sha, b])).values()], DOWNLOAD_CONCURRENCY, download);

  const read = async (files: readonly TreeBlob[]) => new Map(await Promise.all(files.map(async (b) => [b.path, await download(b)] as const)));
  const [base, head] = [await scanFiles(await read(baseFiles)), await scanFiles(await read(headFiles))];

  return {
    ...diffEnvVars(base, head),
    envFiles: committedEnvFiles(baseTree.blobs, headTree.blobs),
    secrets: findSecrets(pullFiles),
    tooLarge: null,
  };
}

async function forEachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

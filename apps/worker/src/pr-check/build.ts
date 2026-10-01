import { createFetchBudget, scanFiles, selectTreeFiles } from '@deployhealth/core';
import type { GithubApi, PullRequestInfo, TreeBlob } from '../github/api';
import { committedEnvFiles, diffEnvVars } from './diff';
import { emptyReport, type PrReport } from './report';
import { findSecrets } from './secrets';

const DOWNLOAD_CONCURRENCY = 8;

/**
 * Read a pull request from GitHub and work out its report, within the hard caps: every file
 * fetched (blobs of both trees, one download per distinct blob, plus the pull request's patches)
 * is reserved against `budget` before it's downloaded, so an oversized pull request is refused
 * before the bulk of the work. Throws LimitExceededError when a cap is hit.
 */
export async function buildReport(api: GithubApi, pr: PullRequestInfo, budget = createFetchBudget()): Promise<PrReport> {
  const [baseTree, headTree] = await Promise.all([api.tree(pr.baseSha), api.tree(pr.headSha)]);
  if (baseTree.truncated || headTree.truncated) {
    return emptyReport('This repository has too many files for GitHub to list in one tree, so it was not checked.');
  }

  const reserved = new Set<string>();
  const contents = new Map<string, Promise<string>>();
  const reserve = (blob: TreeBlob) => {
    if (reserved.has(blob.sha)) return;
    budget.take(blob.size);
    reserved.add(blob.sha);
  };
  const download = (blob: TreeBlob) => {
    let text = contents.get(blob.sha);
    if (!text) {
      text = api.blob(blob.sha).then((buffer) => {
        budget.verify(blob.size, buffer.length);
        return buffer.toString('utf8');
      });
      contents.set(blob.sha, text);
    }
    return text;
  };

  // Choose the files each side would scan (reading .gitignore files as needed, top-down).
  const select = async (blobs: readonly TreeBlob[]) => {
    const byPath = new Map(blobs.map((b) => [b.path, b]));
    const sizes = new Map(blobs.map((b) => [b.path, b.size]));
    const paths = await selectTreeFiles(
      [...byPath.keys()],
      (path) => {
        const blob = byPath.get(path)!;
        reserve(blob);
        return download(blob);
      },
      { sizes },
    );
    return paths.map((path) => byPath.get(path)!);
  };
  const baseFiles = await select(baseTree.blobs);
  const headFiles = await select(headTree.blobs);

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

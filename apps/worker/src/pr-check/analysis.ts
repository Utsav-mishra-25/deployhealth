import { scanFiles, selectTreeFiles } from '@deployhealth/core';
import type { PrEnvFile } from '@deployhealth/db';
import type { PullFile, TreeBlob } from '../github/api';
import { committedEnvFiles, diffEnvVars, type EnvVarDiff } from './diff';
import { totals, type ReportCounts } from './report';
import { findSecrets, type SecretHit } from './secrets';

/**
 * Rows the isolate hands back per list (added, removed, renamed, env files, secrets), and names in
 * `undeclared` (which the web app counts). Exact totals travel in `counts`. Bounded, so copying the
 * result back to the main thread, storing and rendering it stays cheap whatever the pull request.
 */
export const MAX_REPORTED_ROWS = 1_000;
export const MAX_REPORTED_UNDECLARED = 10_000;

// The pull request check's CPU work, as pure functions of data already downloaded. They run in
// the isolate (isolate.ts), never on the worker's main event loop.

export interface SelectInput {
  base: ReadonlyArray<Pick<TreeBlob, 'path' | 'size'>>;
  head: ReadonlyArray<Pick<TreeBlob, 'path' | 'size'>>;
}

/** The paths each side would scan (selectTreeFiles), sorted. */
export function selectFiles({ base, head }: SelectInput): { base: string[]; head: string[] } {
  const pick = (blobs: SelectInput['base']) => selectTreeFiles(blobs.map((b) => b.path), { sizes: new Map(blobs.map((b) => [b.path, b.size])) });
  return { base: pick(base), head: pick(head) };
}

export interface AnalyzeInput {
  /** [path, text] of each side's selected files. */
  base: ReadonlyArray<readonly [string, string]>;
  head: ReadonlyArray<readonly [string, string]>;
  /** Every blob of each tree (path and sha), for committed env files. */
  baseTree: ReadonlyArray<Pick<TreeBlob, 'path' | 'sha'>>;
  headTree: ReadonlyArray<Pick<TreeBlob, 'path' | 'sha'>>;
  pullFiles: readonly PullFile[];
}

export interface Analysis extends EnvVarDiff {
  envFiles: PrEnvFile[];
  secrets: SecretHit[];
  counts: ReportCounts;
}

/** Scan both sides, diff them, and look for committed env files and secrets on added lines. */
export async function analyze(input: AnalyzeInput): Promise<Analysis> {
  const [base, head] = [await scanFiles(new Map(input.base)), await scanFiles(new Map(input.head))];
  const full = {
    ...diffEnvVars(base, head),
    envFiles: committedEnvFiles(input.baseTree, input.headTree),
    secrets: findSecrets(input.pullFiles),
  };
  return {
    added: full.added.slice(0, MAX_REPORTED_ROWS),
    removed: full.removed.slice(0, MAX_REPORTED_ROWS),
    renamed: full.renamed.slice(0, MAX_REPORTED_ROWS),
    undeclared: full.undeclared.slice(0, MAX_REPORTED_UNDECLARED),
    envFiles: full.envFiles.slice(0, MAX_REPORTED_ROWS),
    secrets: full.secrets.slice(0, MAX_REPORTED_ROWS),
    counts: totals(full),
  };
}

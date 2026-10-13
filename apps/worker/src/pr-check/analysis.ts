import { MAX_SOURCE_FILE_BYTES, passesTreeRules, scanFiles, selectTreeFiles, treeMarkers, type DocsStackSlug } from '@deployhealth/core';
import { posix } from 'node:path';
import type { PrEnvFile } from '@deployhealth/db';
import type { PullFile, TreeBlob } from '../github/api';
import { treeCoverage, type Coverage } from './coverage';
import { committedEnvFiles, diffEnvVars, type EnvVarDiff } from './diff';
import { detectFrameworks } from './framework';
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
  base: ReadonlyArray<Pick<TreeBlob, 'path' | 'sha' | 'size'>>;
  head: ReadonlyArray<Pick<TreeBlob, 'path' | 'sha' | 'size'>>;
}

export interface Selection {
  /** The paths each side would scan (selectTreeFiles), sorted. */
  base: string[];
  head: string[];
  /** What those are, and what the pull request changes, from the listings alone (coverage.ts). */
  coverage: Coverage;
  /**
   * Head's package.json files outside vendored, build-output and test paths, up to 512 KB each:
   * downloaded (within the caps) only when the check reads code, to see whether head uses Next.js.
   */
  packageJsons: string[];
}

/** Choose each side's files and work out the coverage: no file contents needed. */
export function selectFiles({ base, head }: SelectInput): Selection {
  const pick = (blobs: SelectInput['base']) => selectTreeFiles(blobs.map((b) => b.path), { sizes: new Map(blobs.map((b) => [b.path, b.size])) });
  const [selectedBase, selectedHead] = [pick(base), pick(head)];
  const markers = treeMarkers(head.map((b) => b.path));
  const packageJsons = head
    .filter((b) => posix.basename(b.path) === 'package.json' && b.size <= MAX_SOURCE_FILE_BYTES && passesTreeRules(b.path, { markers }))
    .map((b) => b.path)
    .sort();
  return { base: selectedBase, head: selectedHead, coverage: treeCoverage(base, head, selectedBase, selectedHead), packageJsons };
}

export interface AnalyzeInput {
  /** [path, text] of each side's selected files. */
  base: ReadonlyArray<readonly [string, string]>;
  head: ReadonlyArray<readonly [string, string]>;
  /** Every blob of each tree (path and sha), for committed env files. */
  baseTree: ReadonlyArray<Pick<TreeBlob, 'path' | 'sha'>>;
  headTree: ReadonlyArray<Pick<TreeBlob, 'path' | 'sha'>>;
  pullFiles: readonly PullFile[];
  /** [path, text] of head's package.json files (Selection.packageJsons); empty when no code is read. */
  packageJsons?: ReadonlyArray<readonly [string, string]>;
}

export interface Analysis extends EnvVarDiff {
  envFiles: PrEnvFile[];
  secrets: SecretHit[];
  counts: ReportCounts;
  /** The frameworks head uses, for the comment's "What this checks" link (framework.ts). */
  frameworks: DocsStackSlug[];
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
    frameworks: detectFrameworks({ headTree: input.headTree.map((b) => b.path), headFiles: input.head, packageJsons: input.packageJsons ?? [] }),
  };
}

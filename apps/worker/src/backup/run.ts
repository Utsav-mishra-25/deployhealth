import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKUP_DUMP_INTERVAL_DAYS, BACKUP_RETENTION_WEEKS } from '@deployhealth/db';
import { deletionsManifest, type AccountDeletionRecord } from '@deployhealth/db/backup';
import { errorLabel } from '../jobs';
import type { R2Bucket, R2Object } from './r2';

/**
 * One run of the backup service (Railway cron, daily at 03:41 UTC; docs/deploy-railway.md step 15):
 * 1. upload deletions.json (every account deletion still on record: GitHub ids and times), so a
 *    restore can re-apply deletions made after its dump even when the live database is gone;
 * 2. take a dump only when the newest in the bucket is older than BACKUP_DUMP_INTERVAL_DAYS, so
 *    there's one a week and a failed run is retried the next day;
 * 3. after a successful upload, and only then, delete all but the BACKUP_RETENTION_WEEKS newest;
 * 4. write the 'backup' heartbeat the worker's stale-backup alert reads.
 * The caller retries a failed run (withRetries) and exits non-zero when every attempt failed.
 */

/** Every dump lives under this prefix; nothing else does. */
export const DUMP_PREFIX = 'deployhealth/';
/** The deletions manifest, at the bucket's root. */
export const MANIFEST_KEY = 'deletions.json';

const DAY_MS = 24 * 3_600_000;

/** `deployhealth/2026-10-18T03-41-00.123Z.dump`: the database time just before the dump started. */
export function dumpKey(at: Date): string {
  return `${DUMP_PREFIX}${at.toISOString().replace(/:/g, '-')}.dump`;
}

/** The time in a dump's key or file name (`…/2026-10-18T03-41-00.123Z.dump`), or null. */
export function dumpTimeOf(keyOrPath: string): Date | null {
  const match = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}(?:\.\d{3})?)Z\.dump$/.exec(keyOrPath);
  if (!match) return null;
  const at = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The bucket's dumps, newest first (only keys that are dumps). */
export function dumpsNewestFirst(objects: readonly R2Object[]): Array<R2Object & { at: Date }> {
  return objects
    .filter((o) => o.key.startsWith(DUMP_PREFIX))
    .flatMap((o) => {
      const at = dumpTimeOf(o.key);
      return at ? [{ ...o, at }] : [];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

export interface BackupRunDeps {
  bucket: R2Bucket;
  /** The database clock. */
  now: () => Promise<Date>;
  listDeletions: () => Promise<AccountDeletionRecord[]>;
  /** pg_dump at least the server's major version, or throw. */
  checkTools: () => Promise<void>;
  dump: (file: string) => Promise<void>;
  heartbeat: () => Promise<void>;
  tmpDir: string;
  log: (message: string) => void;
}

export interface BackupRunResult {
  deletions: number;
  /** The new dump's key, or null when the newest was recent enough. */
  dumped: string | null;
  pruned: string[];
}

export async function runBackup(deps: BackupRunDeps): Promise<BackupRunResult> {
  const now = await deps.now();
  const deletions = await deps.listDeletions();
  await deps.bucket.putText(MANIFEST_KEY, `${JSON.stringify(deletionsManifest(deletions, now))}\n`);
  deps.log(`[backup] ${MANIFEST_KEY} uploaded: ${deletions.length} account deletion${deletions.length === 1 ? '' : 's'} on record`);

  const newest = dumpsNewestFirst(await deps.bucket.list(DUMP_PREFIX))[0];
  if (newest && now.getTime() - newest.at.getTime() < BACKUP_DUMP_INTERVAL_DAYS * DAY_MS) {
    deps.log(`[backup] newest dump is ${((now.getTime() - newest.at.getTime()) / DAY_MS).toFixed(1)} days old; the next is due after ${BACKUP_DUMP_INTERVAL_DAYS}`);
    await deps.heartbeat();
    return { deletions: deletions.length, dumped: null, pruned: [] };
  }

  await deps.checkTools();
  const key = dumpKey(now);
  const file = join(deps.tmpDir, key.slice(DUMP_PREFIX.length));
  const started = Date.now();
  try {
    await deps.dump(file);
    await deps.bucket.putFile(key, file);
  } finally {
    await rm(file, { force: true });
  }
  const uploaded = dumpsNewestFirst(await deps.bucket.list(DUMP_PREFIX));
  if (!uploaded.some((d) => d.key === key)) throw new Error(`the new dump ${key} isn't in the bucket after its upload`);
  deps.log(`[backup] ${key} uploaded (${(uploaded.find((d) => d.key === key)!.size / 1024 / 1024).toFixed(1)} MB) in ${Math.round((Date.now() - started) / 1000)}s`);

  // Only after a successful upload: keep the newest BACKUP_RETENTION_WEEKS.
  const pruned: string[] = [];
  for (const old of uploaded.slice(BACKUP_RETENTION_WEEKS)) {
    await deps.bucket.delete(old.key);
    pruned.push(old.key);
  }
  if (pruned.length) deps.log(`[backup] deleted ${pruned.length} older dump${pruned.length === 1 ? '' : 's'}; ${BACKUP_RETENTION_WEEKS} kept`);
  await deps.heartbeat();
  return { deletions: deletions.length, dumped: key, pruned };
}

/** Delays before the 2nd and 3rd attempts: a failed run is retried twice in-process. */
export const BACKUP_RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;

export async function withRetries<T>(
  run: () => Promise<T>,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; log: (message: string) => void; describe: (error: unknown) => string },
): Promise<T> {
  const delays = options.delaysMs ?? BACKUP_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt > delays.length) throw error;
      options.log(`[backup] attempt ${attempt} of ${delays.length + 1} failed (${options.describe(error)}); retrying in ${Math.round(delays[attempt - 1]! / 1000)}s`);
      await sleep(delays[attempt - 1]!);
    }
  }
}

/** An error for the log: the name and code, plus the message of our own errors (safe and redacted). */
export function describeBackupError(error: unknown): string {
  if (error instanceof Error && ['BackupError', 'R2Error'].includes(error.name)) return `${error.name}: ${error.message}`;
  return errorLabel(error);
}

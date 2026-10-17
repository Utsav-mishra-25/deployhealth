import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import type { Db } from '@deployhealth/db';
import { BackupError, parseDeletionsManifest, type AccountDeletionRecord, type ReapplyResult } from '@deployhealth/db/backup';
import type { R2Bucket } from './r2';
import { DUMP_PREFIX, dumpsNewestFirst, dumpTimeOf, MANIFEST_KEY } from './run';

/**
 * Restoring a backup into an EMPTY scratch database (docs/maintenance.md, "Restore from backup"):
 * pick a dump (the newest, a key, or a downloaded file), restore it, then re-apply every account
 * deletion made at or after the dump's time, from deletions.json in the bucket and, with
 * --live-deletions, from the live database too (DATABASE_URL, read only). It never writes to
 * anything but the --into database, and refuses one that has tables.
 */

export interface RestoreArgs {
  mode: 'list' | 'download' | 'restore';
  source?: { latest: true } | { key: string } | { file: string };
  into?: string;
  /** --download: the directory the dump and deletions.json are saved to. */
  downloadDir?: string;
  /** deletions.json saved by --download, instead of the bucket's. */
  deletionsFile?: string;
  liveDeletions: boolean;
  skipDeletions: boolean;
}

export const RESTORE_USAGE = `Usage:
  node apps/worker/dist/restore.js --list
  node apps/worker/dist/restore.js (--latest | --key <key>) --download <dir>
  node apps/worker/dist/restore.js (--latest | --key <key> | --file <path>) --into <postgres URL of an empty database>
                                   [--deletions-file <path>] [--live-deletions] [--skip-deletions]`;

export function parseRestoreArgs(argv: readonly string[]): RestoreArgs | { error: string } {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        list: { type: 'boolean', default: false },
        latest: { type: 'boolean', default: false },
        key: { type: 'string' },
        file: { type: 'string' },
        into: { type: 'string' },
        download: { type: 'string' },
        'deletions-file': { type: 'string' },
        'live-deletions': { type: 'boolean', default: false },
        'skip-deletions': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    return { error: `${(error as Error).message}\n${RESTORE_USAGE}` };
  }
  const flags = { liveDeletions: values['live-deletions'] === true, skipDeletions: values['skip-deletions'] === true };
  if (values.list) return { mode: 'list', ...flags };
  const sources = [values.latest ? { latest: true as const } : null, values.key ? { key: values.key } : null, values.file ? { file: values.file } : null].filter((s) => s !== null);
  if (sources.length !== 1) return { error: `Give exactly one of --latest, --key or --file.\n${RESTORE_USAGE}` };
  if (values.download !== undefined) {
    if ('file' in sources[0]!) return { error: '--download takes --latest or --key, not --file.' };
    if (values.into) return { error: '--download saves files; it restores nothing (no --into).' };
    return { mode: 'download', source: sources[0]!, downloadDir: values.download, ...flags };
  }
  if (!values.into) return { error: `--into <postgres URL of an empty database> is required.\n${RESTORE_USAGE}` };
  if (flags.skipDeletions && (flags.liveDeletions || values['deletions-file'])) return { error: '--skip-deletions contradicts --live-deletions and --deletions-file.' };
  return { mode: 'restore', source: sources[0]!, into: values.into, deletionsFile: values['deletions-file'], ...flags };
}

/** "13 hours", "2.5 days". */
export function age(ms: number): string {
  const hours = ms / 3_600_000;
  return hours < 48 ? `${Math.max(0, Math.round(hours))} hour${Math.round(hours) === 1 ? '' : 's'}` : `${(hours / 24).toFixed(1)} days`;
}

export interface RestoreDeps {
  /** The backup bucket, when BACKUP_R2_* are set. */
  bucket: R2Bucket | null;
  /** account_deletions from the live database (DATABASE_URL), when set. */
  liveDeletions: (() => Promise<AccountDeletionRecord[]>) | null;
  /** Whether the --into URL is the live database (refused). */
  isLiveDatabase: (url: string) => boolean;
  openTarget: (url: string) => Promise<{ db: Db; close: () => Promise<void> }>;
  isEmpty: (db: Db) => Promise<boolean>;
  checkTool: (db: Db) => Promise<void>;
  restore: (file: string, url: string) => Promise<void>;
  reapply: (db: Db, deletions: AccountDeletionRecord[], dumpedAt: Date) => Promise<ReapplyResult>;
  rowCounts: (db: Db) => Promise<Record<string, number>>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
  tmpDir: string;
  now: () => Date;
  log: (message: string) => void;
}

/** --list: the dumps (newest first) and deletions.json, with their ages. */
export async function listBackups(deps: Pick<RestoreDeps, 'bucket' | 'now' | 'log'>): Promise<void> {
  if (!deps.bucket) throw new BackupError('Set BACKUP_R2_ACCOUNT_ID, BACKUP_R2_BUCKET, BACKUP_R2_ACCESS_KEY_ID and BACKUP_R2_SECRET_ACCESS_KEY to list backups.');
  const now = deps.now().getTime();
  const dumps = dumpsNewestFirst(await deps.bucket.list(DUMP_PREFIX));
  if (dumps.length === 0) deps.log('No dumps in the bucket.');
  for (const d of dumps) deps.log(`${d.key}  ${(d.size / 1024 / 1024).toFixed(1)} MB  ${age(now - d.at.getTime())} old`);
  const manifest = await deps.bucket.getText(MANIFEST_KEY);
  deps.log(manifest ? `${MANIFEST_KEY}  written ${age(now - parseDeletionsManifest(manifest).generatedAt.getTime())} ago` : `${MANIFEST_KEY}  missing`);
}

async function chooseDump(bucket: R2Bucket, source: { latest: true } | { key: string }) {
  const dumps = dumpsNewestFirst(await bucket.list(DUMP_PREFIX));
  const chosen = 'latest' in source ? dumps[0] : dumps.find((d) => d.key === source.key);
  if (!chosen) throw new BackupError('latest' in source ? 'No dumps in the bucket.' : `No dump ${source.key} in the bucket (--list shows them).`);
  return chosen;
}

/**
 * --download: save a dump (under its bucket name, which holds its time) and deletions.json into a
 * directory, for a restore run where the bucket's keys aren't available (docs/maintenance.md).
 */
export async function downloadBackup(args: RestoreArgs & { mode: 'download' }, deps: Pick<RestoreDeps, 'bucket' | 'now' | 'log' | 'writeFile'>): Promise<void> {
  if (!deps.bucket) throw new BackupError('Set the BACKUP_R2_* variables to download from the bucket.');
  const chosen = await chooseDump(deps.bucket, args.source as { latest: true } | { key: string });
  const file = join(args.downloadDir!, chosen.key.slice(DUMP_PREFIX.length));
  deps.log(`[restore] downloading ${chosen.key} (${(chosen.size / 1024 / 1024).toFixed(1)} MB, ${age(deps.now().getTime() - chosen.at.getTime())} old) to ${file}`);
  await deps.bucket.getToFile(chosen.key, file);
  const manifest = await deps.bucket.getText(MANIFEST_KEY);
  if (!manifest) throw new BackupError(`${MANIFEST_KEY} isn't in the bucket: the dump was saved, but there's no record of deletions to re-apply with it.`);
  const parsed = parseDeletionsManifest(manifest);
  await deps.writeFile(join(args.downloadDir!, MANIFEST_KEY), manifest);
  deps.log(`[restore] ${MANIFEST_KEY} saved too (written ${age(deps.now().getTime() - parsed.generatedAt.getTime())} ago). Both hold production data: delete them when you're done.`);
}

/** Restore one dump into an empty database and re-apply the deletions made since. */
export async function restoreBackup(args: RestoreArgs & { mode: 'restore' }, deps: RestoreDeps): Promise<void> {
  const into = args.into!;
  if (deps.isLiveDatabase(into)) throw new BackupError('--into is the live database (DATABASE_URL). Restore into an empty scratch database; switching over is a separate step (docs/maintenance.md).');

  // 1. Where the deletions come from, before anything is downloaded or restored.
  const deletions: AccountDeletionRecord[] = [];
  const sources: string[] = [];
  if (!args.skipDeletions) {
    const manifestText = args.deletionsFile ? await deps.readFile(args.deletionsFile) : deps.bucket ? await deps.bucket.getText(MANIFEST_KEY) : null;
    if (manifestText) {
      const manifest = parseDeletionsManifest(manifestText);
      deletions.push(...manifest.deletions);
      const where = args.deletionsFile ? `${basename(args.deletionsFile)} (saved by --download)` : `${MANIFEST_KEY} from the bucket`;
      sources.push(`${where}, written ${age(deps.now().getTime() - manifest.generatedAt.getTime())} ago (${manifest.generatedAt.toISOString()}; ${manifest.deletions.length} deletions)`);
    }
    if (args.liveDeletions) {
      if (!deps.liveDeletions) throw new BackupError('--live-deletions reads the live database: set DATABASE_URL to it.');
      const live = await deps.liveDeletions();
      deletions.push(...live);
      sources.push(`the live database (${live.length} deletions)`);
    }
    if (sources.length === 0) {
      throw new BackupError(
        `No record of account deletions to re-apply: ${MANIFEST_KEY} isn't in the bucket${deps.bucket ? '' : ' (BACKUP_R2_* aren\'t set)'} and --live-deletions wasn't given. Re-run with one, or with --skip-deletions to restore without re-applying any (only for a scratch check).`,
      );
    }
    if (!args.liveDeletions) deps.log(`[restore] Deletions made after ${MANIFEST_KEY} was written aren't in it; add --live-deletions while the live database is reachable.`);
  } else {
    deps.log('[restore] --skip-deletions: no account deletions will be re-applied. Never switch production to this database.');
  }
  for (const source of sources) deps.log(`[restore] account deletions from ${source}`);

  // 2. The target: empty, and reachable by this pg_restore.
  const target = await deps.openTarget(into);
  try {
    if (!(await deps.isEmpty(target.db))) throw new BackupError('The --into database has tables. Restore only into an empty database (createdb a new one).');
    await deps.checkTool(target.db);

    // 3. The dump: downloaded, or a file named as it was in the bucket (its name holds its time).
    let file: string;
    let dumpedAt: Date | null;
    const source = args.source!;
    if ('file' in source) {
      file = source.file;
      dumpedAt = dumpTimeOf(basename(file));
      if (!dumpedAt) throw new BackupError(`Can't tell when ${basename(file)} was taken: keep the name it had in the bucket (2026-10-18T03-41-00.123Z.dump).`);
    } else {
      if (!deps.bucket) throw new BackupError('Set the BACKUP_R2_* variables to restore from the bucket, or use --file.');
      const chosen = await chooseDump(deps.bucket, source);
      file = join(deps.tmpDir, chosen.key.slice(DUMP_PREFIX.length));
      deps.log(`[restore] downloading ${chosen.key} (${(chosen.size / 1024 / 1024).toFixed(1)} MB, ${age(deps.now().getTime() - chosen.at.getTime())} old)`);
      await deps.bucket.getToFile(chosen.key, file);
      dumpedAt = chosen.at;
    }

    // 4. Restore, then re-apply every deletion at or after the dump's time.
    deps.log('[restore] restoring into the empty database');
    await deps.restore(file, into);
    if (!args.skipDeletions) {
      const result = await deps.reapply(target.db, deletions, dumpedAt);
      deps.log(
        `[restore] re-applied ${result.deleted} account deletion${result.deleted === 1 ? '' : 's'} made since the dump (${result.considered} on record since ${dumpedAt.toISOString()}; ${result.notInDump} not in the dump)`,
      );
    }
    deps.log('[restore] rows per table:');
    for (const [table, n] of Object.entries(await deps.rowCounts(target.db))) deps.log(`  ${table.padEnd(40)} ${n}`);
  } finally {
    await target.close();
  }
}

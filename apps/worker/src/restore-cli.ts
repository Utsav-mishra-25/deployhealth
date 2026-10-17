// Restore a backup into an EMPTY scratch database (dist/restore.js; docs/maintenance.md, "Restore
// from backup"). Run where pg_restore 18 is installed, with the BACKUP_R2_* variables (railway run
// --service backup -- …), or with the files --download saved (--file and --deletions-file);
// --live-deletions also reads DATABASE_URL, read only.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb } from '@deployhealth/db';
import { assertToolCanReach, isEmptyDatabase, listAccountDeletions, pgEnv, reapplyDeletions, restoreDump, rowCounts } from '@deployhealth/db/backup';
import { installConsoleRedaction } from '@deployhealth/db/redact';
import { r2Bucket } from './backup/r2';
import { downloadBackup, listBackups, parseRestoreArgs, restoreBackup } from './backup/restore';
import { describeBackupError } from './backup/run';
import { restoreEnv } from './env';

/** Same host, port and database name: the same database, whatever the credentials. */
export function sameDatabase(a: string, b: string): boolean {
  try {
    const [x, y] = [pgEnv(a), pgEnv(b)];
    return x.PGHOST!.toLowerCase() === y.PGHOST!.toLowerCase() && x.PGPORT === y.PGPORT && x.PGDATABASE === y.PGDATABASE;
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  installConsoleRedaction();
  const log = (message: string) => console.log(message);
  const args = parseRestoreArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(args.error);
    return 2;
  }
  let env;
  try {
    env = restoreEnv();
  } catch (error) {
    console.error(`[restore] ${(error as Error).message}`);
    return 1;
  }
  const bucket = env.R2 ? r2Bucket(env.R2) : null;
  const tmpDir = await mkdtemp(join(tmpdir(), 'deployhealth-restore-'));
  const live = env.DATABASE_URL ? createDb(env.DATABASE_URL, { max: 1 }) : null;
  try {
    if (args.mode === 'list') {
      await listBackups({ bucket, now: () => new Date(), log });
      return 0;
    }
    if (args.mode === 'download') {
      await downloadBackup(args as typeof args & { mode: 'download' }, {
        bucket,
        liveDeletions: live ? () => listAccountDeletions(live.db) : null,
        now: () => new Date(),
        log,
        writeFile: (path, text) => writeFile(path, text),
      });
      return 0;
    }
    await restoreBackup(args as typeof args & { mode: 'restore' }, {
      bucket,
      liveDeletions: live ? () => listAccountDeletions(live.db) : null,
      isLiveDatabase: (url) => env.DATABASE_URL !== null && sameDatabase(url, env.DATABASE_URL),
      openTarget: async (url) => {
        const handle = createDb(url, { max: 2 });
        return { db: handle.db, close: () => handle.close() };
      },
      isEmpty: isEmptyDatabase,
      checkTool: async (db) => void (await assertToolCanReach(db, 'pg_restore')),
      restore: restoreDump,
      reapply: reapplyDeletions,
      rowCounts,
      readFile: (path) => readFile(path, 'utf8'),
      writeFile: (path, text) => writeFile(path, text),
      tmpDir,
      now: () => new Date(),
      log,
    });
    log('[restore] done. Check the counts, then sign in against it before any switch-over (docs/maintenance.md).');
    return 0;
  } catch (error) {
    console.error(`[restore] failed: ${describeBackupError(error)}`);
    return 1;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await live?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

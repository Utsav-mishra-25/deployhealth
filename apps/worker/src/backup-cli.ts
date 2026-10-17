// The backup service's command (dist/backup.js), run by Railway cron daily at 03:41 UTC
// (docs/deploy-railway.md step 15) from apps/worker/backup.Dockerfile, which installs pg_dump 18. One run:
// deletions.json, a dump when the newest is older than 6.5 days, the 4-newest prune, the heartbeat
// (backup/run.ts). Retried twice in-process; exits non-zero when every attempt failed, so Railway
// marks the run failed, and Sentry gets the error.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BACKUP_HEARTBEAT, createDb, recordHeartbeat } from '@deployhealth/db';
import { assertToolCanReach, databaseNow, dumpDatabase, listAccountDeletions } from '@deployhealth/db/backup';
import { installConsoleRedaction } from '@deployhealth/db/redact';
import { flushReports, initSentry, reportError } from '@deployhealth/db/sentry';
import { r2Bucket } from './backup/r2';
import { describeBackupError, runBackup, withRetries } from './backup/run';
import { backupEnv } from './env';

async function main(): Promise<number> {
  installConsoleRedaction();
  const log = (message: string) => console.log(message);
  let env;
  try {
    env = backupEnv();
  } catch (error) {
    console.error(`[backup] ${(error as Error).message}`);
    return 1;
  }
  initSentry({ dsn: env.SENTRY_DSN, release: env.RAILWAY_GIT_COMMIT_SHA, environment: env.NODE_ENV }, 'backup', log);
  const handle = createDb(env.DATABASE_URL, { max: 2 });
  const tmpDir = await mkdtemp(join(tmpdir(), 'deployhealth-backup-'));
  try {
    const bucket = r2Bucket(env.R2);
    const result = await withRetries(
      () =>
        runBackup({
          bucket,
          now: () => databaseNow(handle.db),
          listDeletions: () => listAccountDeletions(handle.db),
          checkTools: async () => void (await assertToolCanReach(handle.db, 'pg_dump')),
          dump: (file) => dumpDatabase(env.DATABASE_URL, file),
          heartbeat: () => recordHeartbeat(handle.db, BACKUP_HEARTBEAT),
          tmpDir,
          log,
        }),
      { log, describe: describeBackupError },
    );
    log(`[backup] done: ${result.dumped ? `dumped ${result.dumped}` : 'no dump due'}`);
    return 0;
  } catch (error) {
    console.error(`[backup] failed after 3 attempts: ${describeBackupError(error)}`);
    reportError(error, { job: 'backup' });
    return 1;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await handle.close();
    await flushReports();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();

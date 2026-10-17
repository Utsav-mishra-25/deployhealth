import { spawn } from 'node:child_process';
import { asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { deleteUser } from './delete-user';
import { redactText } from './redact';
import { accountDeletions, users } from './schema';

// Database backups (Phase 9b): pg_dump and pg_restore around the database, the deletions manifest
// stored next to the dumps, and re-applying account deletions after a restore so a restore never
// brings a deleted account back. The R2 side (upload, list, prune) is the worker's
// (apps/worker/src/backup/). Connection details reach pg_dump and pg_restore as PG* environment
// variables, never on the command line (where `ps` would show them).

/** Why a backup or restore step failed. The message is safe to log (redacted). */
export class BackupError extends Error {
  constructor(message: string) {
    super(redactText(message));
    this.name = 'BackupError';
  }
}

/** Schemas left out of every dump: pg-boss's job queue is transient and rebuilt on start. */
export const DUMP_EXCLUDED_SCHEMAS = ['pgboss'] as const;

/** libpq's environment variables for a postgres:// URL (password included; never argv). */
export function pgEnv(url: string): Record<string, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BackupError('The database URL is not a URL.');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') throw new BackupError('The database URL must start with postgres:// or postgresql://.');
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database) throw new BackupError('The database URL needs a host and a database name.');
  const env: Record<string, string> = {
    PGHOST: parsed.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: parsed.port || '5432',
    PGDATABASE: database,
    PGCONNECT_TIMEOUT: '15',
  };
  if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** Run a PostgreSQL client tool with the connection in its environment; rejects with its last stderr line. */
function runTool(tool: 'pg_dump' | 'pg_restore', args: readonly string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    // PATH only (to find the tool) plus the connection: nothing else from this process's environment.
    const child = spawn(tool, args, { env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout = (stdout + chunk.toString('utf8')).slice(-64_000)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-64_000)));
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(new BackupError(error.code === 'ENOENT' ? `${tool} is not installed (install postgresql-client-${BACKUP_PG_MAJOR}).` : `${tool} could not start: ${error.code ?? error.name}`)),
    );
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout);
      const last = stderr.trim().split('\n').filter(Boolean).at(-1) ?? 'no output';
      reject(new BackupError(`${tool} exited with code ${code}: ${last}`));
    });
  });
}

/** The PostgreSQL major version production runs, which the backup image's client tools match. */
export const BACKUP_PG_MAJOR = 18;

/** The major version of a client tool (`pg_dump (PostgreSQL) 18.4` → 18). */
export async function toolMajorVersion(tool: 'pg_dump' | 'pg_restore'): Promise<number> {
  const out = await runTool(tool, ['--version'], {});
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(out);
  if (!match) throw new BackupError(`Couldn't read ${tool}'s version.`);
  return Number(match[1]);
}

/** The server's major version (18 for 18.4). */
export async function serverMajorVersion(db: Db): Promise<number> {
  const result = await db.execute<{ major: number }>(sql`select current_setting('server_version_num')::int / 10000 as major`);
  return Number(result.rows[0]!.major);
}

/** pg_dump and pg_restore must be at least the server's major version: refuse before starting otherwise. */
export async function assertToolCanReach(db: Db, tool: 'pg_dump' | 'pg_restore'): Promise<{ tool: number; server: number }> {
  const [client, server] = await Promise.all([toolMajorVersion(tool), serverMajorVersion(db)]);
  if (client < server) throw new BackupError(`${tool} ${client} can't work with a PostgreSQL ${server} server: install postgresql-client-${server}.`);
  return { tool: client, server };
}

/** The database clock: dump keys and re-applied deletions compare on it. */
export async function databaseNow(db: Db): Promise<Date> {
  const result = await db.execute<{ now: Date | string }>(sql`select now() as now`);
  return new Date(result.rows[0]!.now);
}

/** Dump the database to `file`: custom format, compressed, no owners or grants, without pg-boss's schema. */
export async function dumpDatabase(url: string, file: string): Promise<void> {
  await runTool(
    'pg_dump',
    ['--format=custom', '--compress=9', '--no-owner', '--no-acl', ...DUMP_EXCLUDED_SCHEMAS.map((s) => `--exclude-schema=${s}`), `--file=${file}`],
    pgEnv(url),
  );
}

/** Restore a dump into the (empty) database at `url`, in one transaction, stopping at the first error. */
export async function restoreDump(file: string, url: string): Promise<void> {
  const env = pgEnv(url);
  await runTool('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', `--dbname=${env.PGDATABASE}`, file], env);
}

/** True when the database has no tables of its own (nothing a restore could overwrite or mix with). */
export async function isEmptyDatabase(db: Db): Promise<boolean> {
  const result = await db.execute<{ n: string }>(
    sql`select count(*) as n from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema')`,
  );
  return Number(result.rows[0]!.n) === 0;
}

/** Exact rows per table (`schema.table`), every schema but the system ones and pg-boss's. */
export async function rowCounts(db: Db): Promise<Record<string, number>> {
  const tables = await db.execute<{ schema: string; name: string }>(
    sql`select table_schema as schema, table_name as name from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema', 'pgboss')
        order by 1, 2`,
  );
  const counts: Record<string, number> = {};
  for (const { schema, name } of tables.rows) {
    const result = await db.execute<{ n: string }>(sql`select count(*) as n from ${sql.identifier(schema)}.${sql.identifier(name)}`);
    counts[`${schema}.${name}`] = Number(result.rows[0]!.n);
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Account deletions after a dump
// ---------------------------------------------------------------------------------------------

export interface AccountDeletionRecord {
  githubId: number;
  deletedAt: Date;
}

/** Every account_deletions row (the last ACCOUNT_DELETION_RECORD_DAYS), oldest first. */
export async function listAccountDeletions(db: Db): Promise<AccountDeletionRecord[]> {
  return db.select({ githubId: accountDeletions.githubId, deletedAt: accountDeletions.deletedAt }).from(accountDeletions).orderBy(asc(accountDeletions.deletedAt));
}

export const DELETIONS_MANIFEST_FORMAT = 'deployhealth-deletions/1';

/** deletions.json, uploaded next to the dumps by every backup run: GitHub ids and times only. */
export interface DeletionsManifest {
  format: typeof DELETIONS_MANIFEST_FORMAT;
  generatedAt: string;
  deletions: Array<{ githubId: number; deletedAt: string }>;
}

export function deletionsManifest(deletions: readonly AccountDeletionRecord[], generatedAt: Date): DeletionsManifest {
  return {
    format: DELETIONS_MANIFEST_FORMAT,
    generatedAt: generatedAt.toISOString(),
    deletions: deletions.map((d) => ({ githubId: d.githubId, deletedAt: d.deletedAt.toISOString() })),
  };
}

/** Parse deletions.json; throws BackupError on anything that isn't one. */
export function parseDeletionsManifest(text: string): { generatedAt: Date; deletions: AccountDeletionRecord[] } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BackupError('deletions.json is not JSON.');
  }
  const manifest = value as Partial<DeletionsManifest> | null;
  if (!manifest || manifest.format !== DELETIONS_MANIFEST_FORMAT || !Array.isArray(manifest.deletions)) throw new BackupError(`deletions.json is not a ${DELETIONS_MANIFEST_FORMAT} file.`);
  const generatedAt = new Date(String(manifest.generatedAt));
  if (Number.isNaN(generatedAt.getTime())) throw new BackupError('deletions.json has no valid generatedAt.');
  const deletions = manifest.deletions.map((d) => {
    const deletedAt = new Date(String(d?.deletedAt));
    if (!Number.isSafeInteger(d?.githubId) || d.githubId <= 0 || Number.isNaN(deletedAt.getTime())) throw new BackupError('deletions.json has an invalid entry.');
    return { githubId: d.githubId, deletedAt };
  });
  return { generatedAt, deletions };
}

export interface ReapplyResult {
  /** Deletions at or after the dump's time (the ones the dump can still hold). */
  considered: number;
  /** Accounts that were in the restored database and are now deleted again. */
  deleted: number;
  /** Deletions whose account wasn't in the dump (created and deleted after it). */
  notInDump: number;
}

/**
 * After a restore: delete again every account deleted at or after `dumpedAt` (the time just before
 * the dump started, so a deletion during the dump is re-applied too, harmlessly), with deleteUser(),
 * keeping each deletion's original time in account_deletions. The latest deletion per GitHub id counts.
 */
export async function reapplyDeletions(db: Db, deletions: readonly AccountDeletionRecord[], dumpedAt: Date): Promise<ReapplyResult> {
  const latest = new Map<number, Date>();
  for (const d of deletions) {
    if (d.deletedAt.getTime() < dumpedAt.getTime()) continue;
    const seen = latest.get(d.githubId);
    if (!seen || seen < d.deletedAt) latest.set(d.githubId, d.deletedAt);
  }
  const result: ReapplyResult = { considered: latest.size, deleted: 0, notInDump: 0 };
  for (const [githubId, deletedAt] of latest) {
    const [user] = await db.select({ createdAt: users.createdAt }).from(users).where(eq(users.githubId, githubId));
    // An account created after the deletion (they signed up again) isn't the one that was deleted.
    if (!user || user.createdAt.getTime() > deletedAt.getTime()) {
      result.notInDump++;
      continue;
    }
    await deleteUser(db, { githubId }, { deletedAt });
    result.deleted++;
  }
  return result;
}

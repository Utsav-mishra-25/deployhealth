import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteOwnAccount } from '../src/account';
import {
  assertToolCanReach,
  BackupError,
  databaseNow,
  deletionsManifest,
  dumpDatabase,
  isEmptyDatabase,
  listAccountDeletions,
  parseDeletionsManifest,
  pgEnv,
  reapplyDeletions,
  restoreDump,
  rowCounts,
} from '../src/backup';
import { createDb, type DbHandle } from '../src/client';
import { getUserByGithubId } from '../src/queries';
import { accountDeletions, alerts, checks, users } from '../src/schema';
import { seed } from '../src/seed';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, TEST_DATABASE_URL, truncateAll } from './test-db';

// A real dump and a real restore, with the pg_dump and pg_restore on PATH: they must be at least
// the server's major version (CI installs postgresql-client-18 for its postgres:18 service), and
// the test fails, never skips, when they aren't.
const handle = openTestDb();
const { db } = handle;
const RESTORE_DB = 'deployhealth_restore_test';
const restoreUrl = (() => {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${RESTORE_DB}`;
  return url.toString();
})();
const dir = mkdtempSync(join(tmpdir(), 'deployhealth-backup-test-'));
let target: DbHandle | null = null;

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function freshTarget(): Promise<DbHandle> {
  await target?.close();
  await admin(`drop database if exists ${RESTORE_DB}`);
  await admin(`create database ${RESTORE_DB}`);
  target = createDb(restoreUrl, { max: 2 });
  return target;
}

/** A user with a client, a project, an endpoint with a check, and an alert. */
async function userWithData(login: string) {
  const user = await makeUser(db, login);
  await makeClient(db, user.id, `${login} co`);
  const project = await makeProject(db, user.id, `${login}-app`);
  const endpoint = await makeEndpoint(db, project.id);
  await db.insert(checks).values({ endpointId: endpoint.id, ok: true, statusCode: 200, latencyMs: 12 });
  await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'down' });
  return user;
}

beforeAll(async () => {
  await truncateAll(db);
  await seed(db, new Date(), { baseUrl: 'https://deployhealth.example' });
});

afterAll(async () => {
  await target?.close();
  await admin(`drop database if exists ${RESTORE_DB}`);
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('dump and restore', () => {
  it('the client tools are at least the server major version', async () => {
    const versions = await assertToolCanReach(db, 'pg_dump');
    expect(versions.tool).toBeGreaterThanOrEqual(versions.server);
    await assertToolCanReach(db, 'pg_restore');
  });

  it('restores a dump into an empty database with the same row count in every table, then a deleted account stays deleted', async () => {
    const alice = await userWithData('alice');
    const bob = await userWithData('bob');
    const before = await rowCounts(db);

    // The dump, as the backup service takes it: its time first, on the database clock.
    const dumpedAt = await databaseNow(db);
    const file = join(dir, 'test.dump');
    await dumpDatabase(TEST_DATABASE_URL, file);
    expect(statSync(file).size).toBeGreaterThan(0);

    // After the dump, alice deletes her account (recorded in account_deletions).
    await deleteOwnAccount(db, alice.id);
    const after = await rowCounts(db);
    expect(after['public.users']).toBe(before['public.users']! - 1);

    const restored = await freshTarget();
    expect(await isEmptyDatabase(restored.db)).toBe(true);
    await restoreDump(file, restoreUrl);
    // Every table, the migration journal included, as it was when the dump was taken.
    expect(await rowCounts(restored.db)).toEqual(before);
    expect(await getUserByGithubId(restored.db, alice.githubId)).not.toBeNull();

    // Re-applying the deletions made since the dump: alice is gone again, bob is whole, and the
    // restored database now matches the live one row for row, the deletion record included.
    const result = await reapplyDeletions(restored.db, await listAccountDeletions(db), dumpedAt);
    expect(result).toEqual({ considered: 1, deleted: 1, notInDump: 0 });
    expect(await getUserByGithubId(restored.db, alice.githubId)).toBeNull();
    expect(await getUserByGithubId(restored.db, bob.githubId)).not.toBeNull();
    expect(await rowCounts(restored.db)).toEqual(after);
    expect(await restored.db.select().from(accountDeletions)).toEqual(await db.select().from(accountDeletions));
  });

  it('re-applies only deletions at or after the dump, once per account, and counts accounts the dump never had', async () => {
    const restored = target!.db;
    const [someone] = await restored.select().from(users).where(sql`${users.githubId} > 0`).limit(1);
    const dumpedAt = new Date('2026-10-01T00:00:00Z');
    const result = await reapplyDeletions(
      restored,
      [
        { githubId: someone!.githubId, deletedAt: new Date('2026-09-30T23:59:59Z') }, // before the dump: already in it
        { githubId: 987654321, deletedAt: new Date('2026-10-02T00:00:00Z') }, // never in the dump
      ],
      dumpedAt,
    );
    expect(result).toEqual({ considered: 1, deleted: 0, notInDump: 1 });
    expect(await getUserByGithubId(restored, someone!.githubId)).not.toBeNull();
  });

  it('a database with tables is not empty', async () => {
    expect(await isEmptyDatabase(db)).toBe(false);
  });

  it('a pg_dump error is a BackupError without the password', async () => {
    const wrong = new URL(TEST_DATABASE_URL);
    wrong.password = 'not-the-password-xyz';
    wrong.pathname = '/no_such_database_xyz';
    const error = await dumpDatabase(wrong.toString(), join(dir, 'never.dump')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackupError);
    expect(String((error as Error).message)).toMatch(/^pg_dump exited with code 1: /);
    expect(String((error as Error).message)).not.toContain('not-the-password-xyz');
  });
});

describe('pgEnv', () => {
  it('passes the connection as libpq variables', () => {
    expect(pgEnv('postgresql://u%40x:p%2Fw@db.internal:6543/railway?sslmode=require')).toEqual({
      PGHOST: 'db.internal',
      PGPORT: '6543',
      PGDATABASE: 'railway',
      PGUSER: 'u@x',
      PGPASSWORD: 'p/w',
      PGSSLMODE: 'require',
      PGCONNECT_TIMEOUT: '15',
    });
  });

  it('refuses what is not a postgres URL, without echoing it', () => {
    for (const url of ['mysql://u:secretpw@h/db', 'not a url', 'postgres://h']) {
      expect(() => pgEnv(url)).toThrow(BackupError);
      try {
        pgEnv(url);
      } catch (error) {
        expect((error as Error).message).not.toContain('secretpw');
      }
    }
  });
});

describe('the deletions manifest', () => {
  it('round-trips GitHub ids and times only', () => {
    const manifest = deletionsManifest([{ githubId: 42, deletedAt: new Date('2026-10-10T10:00:00Z') }], new Date('2026-10-18T03:41:00Z'));
    expect(manifest).toEqual({ format: 'deployhealth-deletions/1', generatedAt: '2026-10-18T03:41:00.000Z', deletions: [{ githubId: 42, deletedAt: '2026-10-10T10:00:00.000Z' }] });
    expect(parseDeletionsManifest(JSON.stringify(manifest))).toEqual({
      generatedAt: new Date('2026-10-18T03:41:00Z'),
      deletions: [{ githubId: 42, deletedAt: new Date('2026-10-10T10:00:00Z') }],
    });
  });

  it('refuses anything else', () => {
    for (const text of ['nope', '{}', '{"format":"deployhealth-deletions/1","generatedAt":"x","deletions":[]}', '{"format":"deployhealth-deletions/1","generatedAt":"2026-10-18T00:00:00Z","deletions":[{"githubId":-1,"deletedAt":"2026-10-01T00:00:00Z"}]}']) {
      expect(() => parseDeletionsManifest(text)).toThrow(BackupError);
    }
  });
});

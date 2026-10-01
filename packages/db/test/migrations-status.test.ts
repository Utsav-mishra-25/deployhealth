import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/client';
import { BUNDLED_MIGRATIONS, pendingMigrations, pgErrorCode } from '../src/migrations-status';
import journal from '../drizzle/meta/_journal.json';
import { openTestDb } from './test-db';

const handle = openTestDb();
const { db } = handle;

afterAll(async () => {
  await handle.close();
});

describe('pendingMigrations', () => {
  it('bundles every migration in the journal, in order', () => {
    expect(BUNDLED_MIGRATIONS.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag));
    expect(BUNDLED_MIGRATIONS.at(-1)?.tag).toBe('0007_worker_heartbeats');
  });

  it('finds nothing pending on a migrated database', async () => {
    expect(await pendingMigrations(db)).toBe(0);
  });

  it('counts migrations the database has not applied', async () => {
    const newer = [...BUNDLED_MIGRATIONS, { when: BUNDLED_MIGRATIONS.at(-1)!.when + 1 }, { when: BUNDLED_MIGRATIONS.at(-1)!.when + 2 }];
    expect(await pendingMigrations(db, newer)).toBe(2);
  });

  it('is ready when the database is ahead of this build', async () => {
    expect(await pendingMigrations(db, BUNDLED_MIGRATIONS.slice(0, 3))).toBe(0);
  });

  it('counts everything as pending on a database never migrated', async () => {
    // Drop drizzle's schema inside a transaction that is rolled back, so the test database stays migrated.
    let pending: number | undefined;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`drop schema drizzle cascade`);
        pending = await pendingMigrations(tx);
        tx.rollback();
      }),
    ).rejects.toThrow('Rollback');
    expect(pending).toBe(BUNDLED_MIGRATIONS.length);
    expect(await pendingMigrations(db)).toBe(0);
  });

  it('throws errors other than "not migrated yet", so the caller can wait on them', async () => {
    const unreachable = createDb('postgres://nobody:nothing@127.0.0.1:1/none', { max: 1 });
    try {
      await expect(pendingMigrations(unreachable.db)).rejects.toSatisfy((e) => pgErrorCode(e) === 'ECONNREFUSED');
    } finally {
      await unreachable.close();
    }
  });
});

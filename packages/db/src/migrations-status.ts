import { sql } from 'drizzle-orm';
import type { Db } from './client';
import journal from '../drizzle/meta/_journal.json';

/** The migrations this build ships with (drizzle-kit's journal, bundled into whatever imports it). */
export const BUNDLED_MIGRATIONS: readonly { tag: string; when: number }[] = journal.entries.map(({ tag, when }) => ({ tag, when }));

/** Postgres codes for a missing schema or table: nothing has been migrated yet. */
const NOT_MIGRATED_CODES = new Set(['3F000', '42P01']);

/**
 * How many of `bundled` the database hasn't applied. drizzle's migrator records each applied
 * migration's journal `when` as `created_at` in drizzle.__drizzle_migrations, so a migration is
 * applied when its `when` is there. A database ahead of this build (web deployed a newer
 * migration first) has nothing pending. Other errors (connection refused, auth) are thrown.
 */
export async function pendingMigrations(db: Db, bundled: readonly { when: number }[] = BUNDLED_MIGRATIONS): Promise<number> {
  let applied: Set<number>;
  try {
    const result = await db.execute<{ created_at: string }>(sql`select created_at from drizzle.__drizzle_migrations`);
    applied = new Set(result.rows.map((row) => Number(row.created_at)));
  } catch (error) {
    if (NOT_MIGRATED_CODES.has(pgErrorCode(error) ?? '')) return bundled.length;
    throw error;
  }
  return bundled.filter((migration) => !applied.has(migration.when)).length;
}

/** The Postgres error code, from the error or the driver error drizzle wraps it around. */
export function pgErrorCode(error: unknown): string | undefined {
  for (let e: unknown = error, depth = 0; e && typeof e === 'object' && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema';

/**
 * A database handle: the pool-backed client from createDb(), or a transaction inside one. Every
 * query function takes this type, so it can run in a caller's transaction (the demo reseed does).
 */
export type Db = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/** Create a pooled connection. Callers own the lifecycle and should `close()` on shutdown. */
export function createDb(connectionString: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

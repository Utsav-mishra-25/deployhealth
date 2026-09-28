import { createDb, type Db, type DbHandle } from '@deployhealth/db';
import { serverEnv } from '@/env';

// One pool per server process. Kept on globalThis so dev hot reloads don't leak pools.
const globalForDb = globalThis as typeof globalThis & { __deployhealthDb?: DbHandle };

export function getDb(): Db {
  globalForDb.__deployhealthDb ??= createDb(serverEnv().DATABASE_URL);
  return globalForDb.__deployhealthDb.db;
}

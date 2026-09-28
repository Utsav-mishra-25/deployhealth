import pg from 'pg';
import { runMigrations } from '../src/migrate';
import { TEST_DATABASE_URL } from './test-db';

/** Rebuild the test database from the migrations once per `vitest run`. */
export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    await client.query('drop schema if exists drizzle cascade');
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
  } finally {
    await client.end();
  }
  await runMigrations(TEST_DATABASE_URL);
}

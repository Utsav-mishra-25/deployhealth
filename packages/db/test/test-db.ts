import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../src/client';
import { projects, users } from '../src/schema';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://deployhealth:deployhealth@localhost:5432/deployhealth_test';

export function openTestDb(): DbHandle {
  return createDb(TEST_DATABASE_URL, { max: 4 });
}

/** Empty every table between tests. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`truncate table users, projects, deploys, scans, findings, endpoints, checks, alerts restart identity cascade`,
  );
}

let counter = 0;

export async function makeUser(db: Db, login = `user${++counter}`) {
  const [user] = await db
    .insert(users)
    .values({ githubId: 1_000_000 + ++counter, login })
    .returning();
  return user!;
}

export async function makeProject(db: Db, ownerId: string, name = `project${++counter}`) {
  const [project] = await db
    .insert(projects)
    .values({
      ownerId,
      name,
      repoFullName: `acme/${name}`,
      apiTokenHash: `hash-${name}-${++counter}`,
      apiTokenHint: 'dh_…test',
    })
    .returning();
  return project!;
}

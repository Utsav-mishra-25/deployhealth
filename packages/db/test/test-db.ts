import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../src/client';
import { clients, endpoints, projects, users } from '../src/schema';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://deployhealth:deployhealth@localhost:5432/deployhealth_test';

export function openTestDb(): DbHandle {
  return createDb(TEST_DATABASE_URL, { max: 4 });
}

/** Empty every table between tests. */
export async function truncateAll(db: Db): Promise<void> {
  await db.execute(
    sql`truncate table users, clients, projects, deploys, scans, findings, scan_variables, endpoints, checks, check_hosts, endpoint_daily_stats, alerts, installations, installation_repos, pr_checks, webhook_deliveries restart identity cascade`,
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

export async function makeClient(db: Db, userId: string, name = `client${++counter}`) {
  const [client] = await db
    .insert(clients)
    .values({ userId, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') })
    .returning();
  return client!;
}

export async function makeEndpoint(db: Db, projectId: string, overrides: Partial<typeof endpoints.$inferInsert> = {}) {
  const [endpoint] = await db
    .insert(endpoints)
    // A host of its own by default, so host spacing only applies where a test shares one on purpose.
    .values({ projectId, url: `https://h${++counter}.example.com/health`, ...overrides })
    .returning();
  return endpoint!;
}

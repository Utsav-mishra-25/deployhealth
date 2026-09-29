import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { users, type User } from './schema';

/**
 * The public demo user. GitHub user ids are positive, so -1 can never collide with a real account.
 * It owns the seeded clients and projects shown at /demo, and it is read-only everywhere: every
 * server action rejects it (apps/web lib/guard.ts), whichever route the request came from.
 */
export const DEMO_GITHUB_ID = -1;
export const DEMO_LOGIN = 'demo';

/**
 * The local dev account the dev-only login signs in as (AUTH_DEMO_LOGIN=1, never in production).
 * Separate from the demo user so local development and the e2e test can create and edit data.
 */
export const DEV_GITHUB_ID = -2;
export const DEV_LOGIN = 'dev';

/** Fixed ids for the demo projects, so /demo/projects/<id> links survive the nightly reseed. */
export const DEMO_PROJECT_IDS = {
  storefront: '0d3e0000-0000-4000-8000-000000000001',
  northwind: '0d3e0000-0000-4000-8000-000000000002',
  portfolio: '0d3e0000-0000-4000-8000-000000000003',
} as const;

export async function getDemoUser(db: Db): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.githubId, DEMO_GITHUB_ID));
  return user ?? null;
}

/** True when `userId` is the public demo user, whose data must never change through the app. */
export async function isDemoUser(db: Db, userId: string): Promise<boolean> {
  const [user] = await db.select({ githubId: users.githubId }).from(users).where(eq(users.id, userId));
  return user?.githubId === DEMO_GITHUB_ID;
}

/** The dev login's account, created on first use. */
export async function ensureDevUser(db: Db): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({ githubId: DEV_GITHUB_ID, login: DEV_LOGIN, name: 'Local dev', email: 'dev@localhost' })
    .onConflictDoUpdate({ target: users.githubId, set: { login: DEV_LOGIN } })
    .returning();
  return user!;
}

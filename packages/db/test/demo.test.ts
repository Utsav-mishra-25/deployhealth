import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_GITHUB_ID, DEV_GITHUB_ID, ensureDevUser, getDemoUser, isDemoUser } from '../src/demo';
import { seed } from '../src/seed';
import { makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

describe('demo and dev users', () => {
  it('finds the demo user only once it is seeded', async () => {
    expect(await getDemoUser(db)).toBeNull();
    const { userId } = await seed(db, new Date('2026-09-28T12:00:00Z'));
    expect(await getDemoUser(db)).toMatchObject({ id: userId, githubId: DEMO_GITHUB_ID });
  });

  it('tells the demo user apart from everyone else, including the dev user', async () => {
    const { userId } = await seed(db, new Date('2026-09-28T12:00:00Z'));
    const dev = await ensureDevUser(db);
    const someone = await makeUser(db);
    expect(await isDemoUser(db, userId)).toBe(true);
    expect(await isDemoUser(db, dev.id)).toBe(false);
    expect(await isDemoUser(db, someone.id)).toBe(false);
    expect(await isDemoUser(db, '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('creates the dev user once and reuses it', async () => {
    const first = await ensureDevUser(db);
    const second = await ensureDevUser(db);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ githubId: DEV_GITHUB_ID, login: 'dev' });
  });
});

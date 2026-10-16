import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertInstallation } from '../src/github';
import { getOnboardingState } from '../src/onboarding';
import { recordScan } from '../src/queries';
import { users } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

async function userWithGithubId(githubId: number, login = `gh${githubId}`) {
  const [user] = await db.insert(users).values({ githubId, login }).returning();
  return user!;
}

describe('getOnboardingState', () => {
  it('is empty for a new user', async () => {
    const user = await makeUser(db);
    expect(await getOnboardingState(db, user.id)).toEqual({ installations: [], projects: [], endpoints: 0, deploys: 0, clients: 0 });
  });

  it("lists the user's installations and projects (oldest first) and counts endpoints, deploys and clients", async () => {
    const alice = await userWithGithubId(101);
    const covered = await makeProject(db, alice.id, 'shop'); // acme/shop
    const uncovered = await makeProject(db, alice.id, 'blog'); // acme/blog
    await upsertInstallation(db, { githubInstallationId: 1, accountLogin: 'acme', accountType: 'Organization', installerGithubId: 101 }, ['acme/shop']);
    await makeEndpoint(db, covered.id);
    await makeEndpoint(db, uncovered.id);
    await recordScan(db, { projectId: covered.id, sha: 'abcdef1', branch: 'main', deployedAt: new Date(), findings: [] });
    await makeClient(db, alice.id, 'Acme Corp');

    const state = await getOnboardingState(db, alice.id);
    expect(state.installations.map((i) => [i.accountLogin, i.repos.map((r) => r.fullName)])).toEqual([['acme', ['acme/shop']]]);
    expect(state.projects.map((p) => p.name)).toEqual(['shop', 'blog']);
    expect(state).toMatchObject({ endpoints: 2, deploys: 1, clients: 1 });
  });
});

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureDevUser, DEV_GITHUB_ID } from '../src/demo';
import { resetDevUser } from '../src/dev-reset';
import { upsertInstallation } from '../src/github';
import { recordScan } from '../src/queries';
import {
  alerts,
  checks,
  clients,
  deploys,
  endpoints,
  findings,
  installationRepos,
  installations,
  prChecks,
  projects,
  scans,
  users,
} from '../src/schema';
import { seed } from '../src/seed';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const TABLES = { users, clients, projects, deploys, scans, findings, endpoints, checks, alerts, installations, installationRepos, prChecks };

async function counts(): Promise<Record<string, number>> {
  const entries = await Promise.all(Object.entries(TABLES).map(async ([name, table]) => [name, (await db.select({ n: count() }).from(table))[0]!.n] as const));
  return Object.fromEntries(entries);
}

describe('resetDevUser (e2e: the first run on a fresh account)', () => {
  it("removes only the dev user's own rows: the demo, its installation and other users stay exactly as they were", async () => {
    await seed(db, new Date());
    const other = await makeUser(db, 'someone');
    const otherProject = await makeProject(db, other.id, 'theirs');
    await makeEndpoint(db, otherProject.id);
    await upsertInstallation(db, { githubInstallationId: 900, accountLogin: 'someone', accountType: 'User', installerGithubId: other.githubId }, ['someone/theirs']);
    const before = await counts();

    const dev = await ensureDevUser(db);
    const devProject = await makeProject(db, dev.id, 'dev-app', 'utsav-test/dev-app');
    await makeEndpoint(db, devProject.id);
    await recordScan(db, { projectId: devProject.id, sha: 'abcdef1', branch: 'main', deployedAt: new Date(), findings: [] });
    await makeClient(db, dev.id, 'Dev Client');
    await upsertInstallation(db, { githubInstallationId: 424242, accountLogin: 'utsav-test', accountType: 'User', installerGithubId: DEV_GITHUB_ID }, ['utsav-test/dev-app']);

    expect(await resetDevUser(db)).toEqual({ projects: 1, clients: 1, installations: 1 });
    // Everything else is exactly as before; only the dev user's row remains of what it added.
    expect(await counts()).toEqual({ ...before, users: before.users! + 1 });
    expect(await db.select({ id: users.id }).from(users).where(eq(users.githubId, DEV_GITHUB_ID))).toEqual([{ id: dev.id }]);
    expect(await resetDevUser(db)).toEqual({ projects: 0, clients: 0, installations: 0 });
  });

  it('does nothing when there is no dev user', async () => {
    await seed(db, new Date());
    const before = await counts();
    expect(await resetDevUser(db)).toEqual({ projects: 0, clients: 0, installations: 0 });
    expect(await counts()).toEqual(before);
  });
});

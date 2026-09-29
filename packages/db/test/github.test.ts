import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentPrStats,
  changeInstallationRepos,
  deleteInstallation,
  findPrCheckTarget,
  findPrCommentId,
  forgetDelivery,
  getGithubAppStatus,
  linkInstallationsForUser,
  listInstallationsForUser,
  listPrChecksForOwner,
  markPullRequestClosed,
  pruneDeliveries,
  recordDelivery,
  setInstallationSuspended,
  updatePrCheckMode,
  upsertInstallation,
  upsertPrCheck,
} from '../src/github';
import { listProjectsForOwner } from '../src/queries';
import { installationRepos, installations, prChecks, projects, users } from '../src/schema';
import { makeClient, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const T0 = new Date('2026-09-28T12:00:00Z');
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

async function userWithGithubId(githubId: number, login = `gh${githubId}`) {
  const [user] = await db.insert(users).values({ githubId, login }).returning();
  return user!;
}

const install = (githubInstallationId: number, installerGithubId: number, repos: string[], accountLogin = 'acme') =>
  upsertInstallation(db, { githubInstallationId, accountLogin, accountType: 'Organization', installerGithubId }, repos);

const check = (projectId: string, installationId: string, prNumber: number, headSha: string, extra: Partial<Parameters<typeof upsertPrCheck>[1]> = {}) =>
  upsertPrCheck(db, {
    projectId,
    installationId,
    prNumber,
    headSha,
    baseSha: 'base0000',
    authorLogin: 'dev',
    conclusion: 'success',
    ...extra,
  });

describe('webhook deliveries', () => {
  it('records each delivery id once, can forget one, and prunes after 24 hours', async () => {
    expect(await recordDelivery(db, 'd-1', T0)).toBe(true);
    expect(await recordDelivery(db, 'd-1', T0)).toBe(false);
    await forgetDelivery(db, 'd-1');
    expect(await recordDelivery(db, 'd-1', T0)).toBe(true);
    await recordDelivery(db, 'd-2', hours(20));
    // The nightly job passes now - 24 h: at T0+25h that removes d-1 (T0) but keeps d-2 (T0+20h).
    expect(await pruneDeliveries(db, hours(25 - 24))).toBe(1);
    expect(await recordDelivery(db, 'd-1', hours(25))).toBe(true);
    expect(await recordDelivery(db, 'd-2', hours(25))).toBe(false);
  });
});

describe('installations', () => {
  it('links to the installer when they have an account, else at their next sign-in', async () => {
    const alice = await userWithGithubId(101);
    const linked = await install(1, 101, ['acme/shop']);
    expect(linked.userId).toBe(alice.id);

    const early = await install(2, 202, ['acme/api']);
    expect(early.userId).toBeNull();
    const bob = await userWithGithubId(202);
    expect(await linkInstallationsForUser(db, bob.id, 202)).toBe(1);
    const [row] = await db.select().from(installations).where(eq(installations.githubInstallationId, 2));
    expect(row!.userId).toBe(bob.id);
    // Someone else signing in never takes it over.
    const mallory = await userWithGithubId(303);
    expect(await linkInstallationsForUser(db, mallory.id, 202)).toBe(0);
  });

  it('keeps the repository list in sync, and a re-install keeps the link and unsuspends', async () => {
    const alice = await userWithGithubId(101);
    await install(1, 101, ['acme/shop', 'acme/api']);
    expect(await changeInstallationRepos(db, 1, { added: ['acme/site'], removed: ['acme/api'] })).toBe(true);
    expect(await changeInstallationRepos(db, 999, { added: ['x/y'] })).toBe(false);
    const repos = await db.select({ r: installationRepos.repoFullName }).from(installationRepos);
    expect(repos.map((r) => r.r).sort()).toEqual(['acme/shop', 'acme/site']);

    await setInstallationSuspended(db, 1, T0);
    const again = await upsertInstallation(db, { githubInstallationId: 1, accountLogin: 'acme-renamed', accountType: 'Organization', installerGithubId: 999 });
    expect(again).toMatchObject({ userId: alice.id, accountLogin: 'acme-renamed', suspendedAt: null });
    expect(await db.$count(installationRepos)).toBe(2); // no list given: untouched
  });

  it('deleting an installation removes its repos and its pull request checks', async () => {
    const alice = await userWithGithubId(101);
    const project = await makeProject(db, alice.id, 'shop');
    const inst = await install(1, 101, [project.repoFullName]);
    await check(project.id, inst.id, 7, 'aaa');
    await deleteInstallation(db, 1);
    expect(await db.$count(installationRepos)).toBe(0);
    expect(await db.$count(prChecks)).toBe(0);
    expect(await db.$count(projects)).toBe(1);
  });
});

describe('findPrCheckTarget', () => {
  it("finds the linked user's project for the repo, case-insensitively", async () => {
    const alice = await userWithGithubId(101);
    const project = await makeProject(db, alice.id, 'shop'); // repo acme/shop
    const inst = await install(1, 101, ['Acme/Shop']);
    expect(await findPrCheckTarget(db, 1, 'ACME/shop')).toEqual({
      installationId: inst.id,
      project: { id: project.id, name: 'shop', prCheckMode: 'comment' },
    });
  });

  it("never picks another user's project that claims the same repo name", async () => {
    const alice = await userWithGithubId(101);
    const mallory = await userWithGithubId(666);
    await makeProject(db, mallory.id, 'shop'); // mallory's project also says acme/shop
    await install(1, 101, ['acme/shop']); // installed by alice, who has no such project
    expect(await findPrCheckTarget(db, 1, 'acme/shop')).toBeNull();
    const mine = await makeProject(db, alice.id, 'shop');
    expect((await findPrCheckTarget(db, 1, 'acme/shop'))?.project.id).toBe(mine.id);
  });

  it('is null for an unlinked or suspended installation, or a repo it cannot see', async () => {
    const alice = await userWithGithubId(101);
    await makeProject(db, alice.id, 'shop');
    await install(1, 999, ['acme/shop']); // installer has no account
    expect(await findPrCheckTarget(db, 1, 'acme/shop')).toBeNull();
    await install(2, 101, ['acme/other']);
    expect(await findPrCheckTarget(db, 2, 'acme/shop')).toBeNull();
    await install(3, 101, ['acme/shop']);
    await setInstallationSuspended(db, 3, T0);
    expect(await findPrCheckTarget(db, 3, 'acme/shop')).toBeNull();
  });
});

describe('pull request checks', () => {
  async function setup() {
    const alice = await userWithGithubId(101);
    const project = await makeProject(db, alice.id, 'shop');
    const inst = await install(1, 101, [project.repoFullName]);
    return { alice, project, inst };
  }

  it('one row per head: re-running a head updates it and keeps its comment and check run', async () => {
    const { project, inst } = await setup();
    const first = await check(project.id, inst.id, 7, 'aaa', { commentId: 555, checkRunId: 777 });
    const again = await check(project.id, inst.id, 7, 'aaa', { conclusion: 'neutral', undeclaredVars: ['X'] });
    expect(again).toMatchObject({ id: first.id, commentId: 555, checkRunId: 777, conclusion: 'neutral', undeclaredVars: ['X'] });
    await check(project.id, inst.id, 7, 'bbb');
    expect(await db.$count(prChecks)).toBe(2);
    expect(await findPrCommentId(db, project.id, 7)).toBe(555);
    expect(await findPrCommentId(db, project.id, 8)).toBeNull();
  });

  it('lists the latest check per pull request for the owner only, and tracks closed ones', async () => {
    const { alice, project, inst } = await setup();
    await check(project.id, inst.id, 7, 'aaa', { undeclaredVars: ['A'], conclusion: 'neutral' });
    await check(project.id, inst.id, 7, 'bbb', { undeclaredVars: [], conclusion: 'success' });
    await check(project.id, inst.id, 8, 'ccc', { undeclaredVars: ['B', 'C'], conclusion: 'neutral', authorIsAgent: true, agentName: 'Claude' });
    const list = await listPrChecksForOwner(db, alice.id, project.id);
    expect(list.map((c) => [c.prNumber, c.headSha, c.undeclared, c.closed])).toEqual([
      [8, 'ccc', 2, false],
      [7, 'bbb', 0, false],
    ]);
    const stranger = await makeUser(db);
    expect(await listPrChecksForOwner(db, stranger.id, project.id)).toEqual([]);

    expect((await listProjectsForOwner(db, alice.id))[0]!.openPrsWithUndeclared).toBe(1);
    expect(await markPullRequestClosed(db, 1, 'ACME/SHOP', 8, T0)).toBe(1);
    expect((await listProjectsForOwner(db, alice.id))[0]!.openPrsWithUndeclared).toBe(0);
    expect((await listPrChecksForOwner(db, alice.id, project.id)).find((c) => c.prNumber === 8)?.closed).toBe(true);
    await markPullRequestClosed(db, 1, 'acme/shop', 8, null); // reopened
    expect((await listProjectsForOwner(db, alice.id))[0]!.openPrsWithUndeclared).toBe(1);
    // Another installation's id closes nothing.
    expect(await markPullRequestClosed(db, 2, 'acme/shop', 8, T0)).toBe(0);
  });

  it('counts agent pull requests that still add undeclared vars, per client and month', async () => {
    const { alice, project, inst } = await setup();
    const client = await makeClient(db, alice.id, 'Acme');
    await db.update(projects).set({ clientId: client.id }).where(eq(projects.id, project.id));
    const at = (iso: string) => ({ createdAt: new Date(iso) }) as const;
    const agent = { authorIsAgent: true, agentName: 'Claude' } as const;
    await db.insert(prChecks).values([
      // PR 1 (agent): undeclared, then fixed in a later push → not counted as undeclared.
      { projectId: project.id, installationId: inst.id, prNumber: 1, headSha: 'a1', baseSha: 'b', authorLogin: 'claude[bot]', conclusion: 'neutral', undeclaredVars: ['X'], ...agent, ...at('2026-09-02T10:00:00Z') },
      { projectId: project.id, installationId: inst.id, prNumber: 1, headSha: 'a2', baseSha: 'b', authorLogin: 'claude[bot]', conclusion: 'success', undeclaredVars: [], ...agent, ...at('2026-09-02T11:00:00Z') },
      // PR 2 (agent): still undeclared.
      { projectId: project.id, installationId: inst.id, prNumber: 2, headSha: 'b1', baseSha: 'b', authorLogin: 'devin-ai-integration[bot]', conclusion: 'neutral', undeclaredVars: ['Y'], ...agent, ...at('2026-09-10T10:00:00Z') },
      // PR 3 (human) and PR 4 (agent, August) don't count.
      { projectId: project.id, installationId: inst.id, prNumber: 3, headSha: 'c1', baseSha: 'b', authorLogin: 'alice', conclusion: 'neutral', undeclaredVars: ['Z'], ...at('2026-09-11T10:00:00Z') },
      { projectId: project.id, installationId: inst.id, prNumber: 4, headSha: 'd1', baseSha: 'b', authorLogin: 'Copilot', conclusion: 'neutral', undeclaredVars: ['Z'], ...agent, ...at('2026-08-30T10:00:00Z') },
    ]);
    const september = [new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z')] as const;
    expect(await agentPrStats(db, alice.id, client.id, ...september)).toEqual({ undeclared: 1, total: 2 });
    const stranger = await makeUser(db);
    expect(await agentPrStats(db, stranger.id, client.id, ...september)).toEqual({ undeclared: 0, total: 0 });
  });
});

describe('project settings: App status and mode (owner-scoped)', () => {
  it('reports not installed, active, suspended, or installed by another account', async () => {
    const alice = await userWithGithubId(101);
    const project = await makeProject(db, alice.id, 'shop');
    expect(await getGithubAppStatus(db, alice.id, project.id)).toEqual({ state: 'not-installed' });
    await install(9, 999, ['acme/shop'], 'acme');
    expect(await getGithubAppStatus(db, alice.id, project.id)).toEqual({ state: 'other-account', accountLogin: 'acme' });
    await install(1, 101, ['acme/shop'], 'alice');
    expect(await getGithubAppStatus(db, alice.id, project.id)).toEqual({ state: 'active', accountLogin: 'alice' });
    await setInstallationSuspended(db, 1, T0);
    expect(await getGithubAppStatus(db, alice.id, project.id)).toEqual({ state: 'suspended', accountLogin: 'alice' });
    const stranger = await makeUser(db);
    expect(await getGithubAppStatus(db, stranger.id, project.id)).toBeNull();
  });

  it('lists only the installations linked to the user, with their repos', async () => {
    const alice = await userWithGithubId(101);
    await install(1, 101, ['acme/shop', 'acme/api'], 'acme');
    await install(2, 999, ['other/repo'], 'other');
    expect(await listInstallationsForUser(db, alice.id)).toEqual([
      { accountLogin: 'acme', accountType: 'Organization', suspended: false, repos: ['acme/api', 'acme/shop'] },
    ]);
  });

  it("changes the mode only on the owner's project", async () => {
    const alice = await userWithGithubId(101);
    const project = await makeProject(db, alice.id, 'shop');
    const stranger = await makeUser(db);
    expect(await updatePrCheckMode(db, stranger.id, project.id, 'off')).toBe(false);
    expect(await updatePrCheckMode(db, alice.id, project.id, 'strict')).toBe(true);
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(row!.prCheckMode).toBe('strict');
  });
});

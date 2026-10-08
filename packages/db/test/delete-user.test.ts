import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { formatCounts, parseCommand, UNINSTALL_REMINDER } from '../src/delete-user-cli';
import { DELETION_TABLES, deleteUser, planUserDeletion, UserDeletionError, type DeletionCounts } from '../src/delete-user';
import { DEMO_GITHUB_ID, DEV_GITHUB_ID, ensureDevUser } from '../src/demo';
import { changeInstallationRepos, findPrCheckTarget, upsertInstallation, upsertPrCheck } from '../src/github';
import { recordScan } from '../src/queries';
import { alerts, checks, endpointDailyStats, users } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

let installationIds = 100;
beforeEach(() => {
  installationIds = 100;
});

/** A user with one of everything a user can own, plus an installation they made but never linked. */
async function userWithEverything(login: string) {
  const user = await makeUser(db, login);
  const client = await makeClient(db, user.id, `${login} co`);
  const project = await makeProject(db, user.id, `${login}-app`);
  await db.execute(sql`update projects set client_id = ${client.id} where id = ${project.id}`);
  await recordScan(db, {
    projectId: project.id,
    sha: 'abcdef1',
    branch: 'main',
    deployedAt: new Date(),
    findings: [{ kind: 'missing', var_name: 'API_KEY', file: 'src/a.ts', line: 1, env_file: null }],
    variables: [{ var_name: 'API_KEY', scope: '', defined_in: [] }],
  });
  const endpoint = await makeEndpoint(db, project.id);
  await db.insert(checks).values({ endpointId: endpoint.id, ok: true, statusCode: 200, latencyMs: 10 });
  await db.insert(endpointDailyStats).values({ endpointId: endpoint.id, day: '2026-09-01', checks: 10, ok: 10 });
  await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'down' });
  const linked = await upsertInstallation(
    db,
    { githubInstallationId: ++installationIds, accountLogin: login, accountType: 'User', installerGithubId: user.githubId },
    [`${login}/${login}-app`, `${login}/other`],
  );
  await upsertPrCheck(db, { projectId: project.id, installationId: linked.id, prNumber: 1, headSha: 'h', baseSha: 'b', authorLogin: login, conclusion: 'success' });
  // Installed by this GitHub account but not linked (user_id null): theirs all the same.
  await db.execute(sql`update installations set user_id = null where id = ${linked.id}`);
  await upsertInstallation(db, { githubInstallationId: ++installationIds, accountLogin: `${login}-org`, accountType: 'Organization', installerGithubId: user.githubId }, [`${login}-org/site`]);
  return user;
}

const ONE_OF_EVERYTHING: DeletionCounts = {
  users: 1,
  clients: 1,
  projects: 1,
  deploys: 1,
  scans: 1,
  findings: 1,
  scan_variables: 1,
  endpoints: 1,
  checks: 1,
  endpoint_daily_stats: 1,
  alerts: 1,
  installations: 2,
  installation_repos: 3,
  pr_checks: 1,
};

/** Rows in every table, to show what a call did or didn't change. */
async function allRows(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of DELETION_TABLES) {
    const { rows } = await db.execute<{ n: string }>(sql`select count(*) as n from ${sql.identifier(table)}`);
    result[table] = Number(rows[0]!.n);
  }
  return result;
}

describe('delete-user', () => {
  it('the dry run counts every table and changes nothing', async () => {
    await userWithEverything('alice');
    await userWithEverything('bob');
    const before = await allRows();
    const plan = await planUserDeletion(db, { login: 'ALICE' });
    expect(plan.user.login).toBe('alice');
    expect(plan.counts).toEqual(ONE_OF_EVERYTHING);
    expect(plan.installationAccounts).toEqual({ user: 1, organization: 1 });
    expect(await allRows()).toEqual(before);
  });

  it("deletes everything the user owns and nothing of another user's", async () => {
    const alice = await userWithEverything('alice'); // installations 101 (alice) and 102 (alice-org)
    await userWithEverything('bob');
    expect(await changeInstallationRepos(db, 101, { added: ['alice/new'] })).toBe(true);
    const bobBefore = await planUserDeletion(db, { login: 'bob' });

    const deleted = await deleteUser(db, { githubId: alice.githubId });
    expect(deleted.counts).toEqual({ ...ONE_OF_EVERYTHING, installation_repos: 4 });
    // Only bob's rows remain: exactly one of everything, in every table.
    expect(await allRows()).toEqual(ONE_OF_EVERYTHING);
    expect(await planUserDeletion(db, { login: 'bob' })).toEqual(bobBefore);
    await expect(planUserDeletion(db, { login: 'alice' })).rejects.toThrow('No user with login "alice".');
    // The App may still be installed on GitHub: its later deliveries find nothing and store nothing.
    expect(await findPrCheckTarget(db, 101, 'alice/alice-app')).toBeNull();
    expect(await changeInstallationRepos(db, 101, { added: ['alice/new'] })).toBe(false);
    expect((await allRows()).installation_repos).toBe(ONE_OF_EVERYTHING.installation_repos);
  });

  it('refuses the demo and dev users, and any non-positive GitHub id', async () => {
    await db.insert(users).values({ githubId: DEMO_GITHUB_ID, login: 'demo' });
    await ensureDevUser(db);
    for (const selector of [{ login: 'demo' }, { githubId: DEMO_GITHUB_ID }, { login: 'dev' }, { githubId: DEV_GITHUB_ID }]) {
      await expect(planUserDeletion(db, selector)).rejects.toThrow(UserDeletionError);
      await expect(deleteUser(db, selector)).rejects.toThrow(/demo or dev user/);
    }
    expect((await allRows()).users).toBe(2);
  });

  it('refuses an unknown user, and a login that matches more than one', async () => {
    await expect(deleteUser(db, { githubId: 42 })).rejects.toThrow('No user with GitHub id 42.');
    const one = await makeUser(db, 'Carol');
    const two = await makeUser(db, 'carol');
    await expect(deleteUser(db, { login: 'carol' })).rejects.toThrow(`2 users have login "carol"; run again with --github-id`);
    expect((await allRows()).users).toBe(2);
    await deleteUser(db, { githubId: two.githubId });
    expect((await planUserDeletion(db, { login: 'carol' })).user.id).toBe(one.id);
  });
});

describe('delete-user command line', () => {
  it('takes exactly one of --login or --github-id, and --confirm', () => {
    expect(parseCommand(['--login', 'alice'])).toEqual({ selector: { login: 'alice' }, confirm: false });
    expect(parseCommand(['--github-id', '123', '--confirm'])).toEqual({ selector: { githubId: 123 }, confirm: true });
    expect(parseCommand([])).toHaveProperty('error');
    expect(parseCommand(['--login', 'a', '--github-id', '1'])).toHaveProperty('error');
    expect(parseCommand(['--github-id', 'abc'])).toHaveProperty('error');
    expect(parseCommand(['--login', ' '])).toHaveProperty('error');
    expect(parseCommand(['--login', 'a', '--yes'])).toHaveProperty('error');
    expect(parseCommand(['alice'])).toHaveProperty('error');
  });

  it('prints the login, the id and counts only', () => {
    const text = formatCounts(
      { user: { id: 'uuid-never-printed', login: 'alice', githubId: 7 }, counts: ONE_OF_EVERYTHING, installationAccounts: { user: 1, organization: 1 } },
      'Would delete:',
    );
    expect(text).toMatch(/^ {2}installations +2 \(1 on a user account, 1 on an organization\)$/m);
    expect(text).toContain('User "alice" (GitHub id 7)');
    expect(text).toMatch(/^ {2}installation_repos +3$/m);
    expect(text).not.toContain('uuid-never-printed');
    expect(text.split('\n')).toHaveLength(2 + DELETION_TABLES.length);
    expect(UNINSTALL_REMINDER).toContain('uninstall');
  });
});

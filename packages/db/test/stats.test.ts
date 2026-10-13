import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DELETION_TABLES } from '../src/delete-user';
import { DEMO_GITHUB_ID, DEMO_INSTALLATION_ID, ensureDevUser } from '../src/demo';
import { upsertInstallation, upsertPrCheck } from '../src/github';
import { recordScan } from '../src/queries';
import { seed } from '../src/seed';
import { installations, prChecks, projects, scans, users } from '../src/schema';
import { formatStats, parseCommand } from '../src/stats-cli';
import { readOnly, usageStats } from '../src/stats';
import { makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
let installationIds = 500;

/** A user created `ageDays` ago with one project, a scan `scanDays` ago, and an installation of each kind. */
async function activeUser(login: string, { ageDays = 1, scanDays = 1 }: { ageDays?: number; scanDays?: number | null } = {}) {
  const user = await makeUser(db, login);
  await db.execute(sql`update users set created_at = ${daysAgo(ageDays).toISOString()}::timestamptz where id = ${user.id}`);
  const project = await makeProject(db, user.id, `${login}-app`);
  await db.execute(sql`update projects set created_at = ${daysAgo(ageDays).toISOString()}::timestamptz where id = ${project.id}`);
  if (scanDays !== null) {
    const { scanId } = await recordScan(db, { projectId: project.id, sha: 'abcdef1', branch: 'main', deployedAt: daysAgo(scanDays), findings: [] });
    await db.execute(sql`update scans set created_at = ${daysAgo(scanDays).toISOString()}::timestamptz where id = ${scanId}`);
  }
  for (const accountType of ['User', 'Organization']) {
    const inst = await upsertInstallation(db, { githubInstallationId: ++installationIds, accountLogin: `${login}-${accountType}`, accountType, installerGithubId: user.githubId }, []);
    await db.execute(sql`update installations set user_id = ${user.id}, created_at = ${daysAgo(ageDays).toISOString()}::timestamptz where id = ${inst.id}`);
  }
  return { user, project };
}

async function allRows(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const table of [...DELETION_TABLES, 'webhook_deliveries', 'check_hosts', 'worker_heartbeats']) {
    const { rows } = await db.execute<{ n: string }>(sql`select count(*) as n from ${sql.identifier(table)}`);
    result[table] = Number(rows[0]!.n);
  }
  return result;
}

describe('usageStats', () => {
  it('counts users, installations by account type and projects, created in the last 7 and 30 days', async () => {
    await activeUser('new', { ageDays: 2 });
    await activeUser('recent', { ageDays: 20, scanDays: 20 });
    await activeUser('old', { ageDays: 90, scanDays: null });
    // Installed but never linked to a user (they haven't signed in): it still counts.
    await upsertInstallation(db, { githubInstallationId: 9001, accountLogin: 'someone', accountType: 'User', installerGithubId: 424242 }, []);

    const stats = await usageStats(db);
    expect(stats.users).toEqual({ total: 3, last7Days: 1, last30Days: 2 });
    expect(stats.projects).toEqual({ total: 3, last7Days: 1, last30Days: 2 });
    expect(stats.installations).toMatchObject({ total: 7, userAccounts: 4, organizations: 3 });
    expect(stats.installations.last7Days).toBe(3); // new's two and the unlinked one, created now
    expect(stats.installations.last30Days).toBe(5);
    expect(stats.excludedByLogin).toBe(0);
  });

  it('counts weekly active projects: a scan or a pull request check in the last 7 days', async () => {
    const scanned = await activeUser('scanned', { scanDays: 3 });
    const checked = await activeUser('checked', { scanDays: 20 });
    await activeUser('idle', { scanDays: 20 });
    await activeUser('never', { scanDays: null });
    const [inst] = await db.select().from(installations).limit(1);
    // Two PR checks on one project, one from last week re-run today (updated_at), one from last month.
    const pr = async (prNumber: number, head: string, created: number, updated: number) => {
      const row = await upsertPrCheck(db, { projectId: checked.project.id, installationId: inst!.id, prNumber, headSha: head, baseSha: 'b', authorLogin: 'x', conclusion: 'success' });
      await db.execute(sql`update pr_checks set created_at = ${daysAgo(created).toISOString()}::timestamptz, updated_at = ${daysAgo(updated).toISOString()}::timestamptz where id = ${row.id}`);
    };
    await pr(1, 'h1', 10, 0);
    await pr(2, 'h2', 2, 2);
    await pr(3, 'h3', 40, 40);
    // A second scan of the scanned project this week: one more scan, still one active project.
    await recordScan(db, { projectId: scanned.project.id, sha: 'abcdef2', branch: 'main', deployedAt: daysAgo(1), findings: [] });

    const stats = await usageStats(db);
    expect(stats.weeklyActiveProjects).toBe(2);
    expect(stats.scansLast7Days).toBe(2);
    expect(stats.pullRequestChecksLast7Days).toBe(1);
  });

  it('always leaves out the demo and dev users and the demo installation, and drops --exclude-login users', async () => {
    await seed(db, new Date());
    const dev = await ensureDevUser(db);
    await makeProject(db, dev.id, 'dev-app');
    const me = await activeUser('Utsav', { scanDays: 1 });
    await activeUser('customer', { scanDays: 1 });
    // An installation the operator made but never linked: left out by the installer's GitHub id.
    await upsertInstallation(db, { githubInstallationId: 9002, accountLogin: 'mine-org', accountType: 'Organization', installerGithubId: me.user.githubId }, []);

    const demoRows = await db.select().from(users).where(sql`${users.githubId} <= 0`);
    expect(demoRows.map((u) => u.githubId).sort((a, b) => a - b)).toEqual([-2, DEMO_GITHUB_ID]);
    expect((await db.select().from(installations).where(sql`${installations.githubInstallationId} = ${DEMO_INSTALLATION_ID}`)).length).toBe(1);
    expect((await db.select().from(prChecks)).length).toBeGreaterThan(0);

    const all = await usageStats(db);
    expect(all.users.total).toBe(2);
    expect(all.projects.total).toBe(2);
    expect(all.installations.total).toBe(5);
    expect(all.weeklyActiveProjects).toBe(2);
    expect(all.scansLast7Days).toBe(2);
    expect(all.pullRequestChecksLast7Days).toBe(0);

    const mine = await usageStats(db, { excludeLogins: ['utsav', ' UTSAV ', 'nobody'] });
    expect(mine).toMatchObject({ users: { total: 1 }, projects: { total: 1 }, installations: { total: 2 }, weeklyActiveProjects: 1, scansLast7Days: 1, excludedByLogin: 1 });
  });

  it('writes nothing: one READ ONLY transaction, and every table is unchanged', async () => {
    await seed(db, new Date());
    await activeUser('someone');
    const before = await allRows();
    await usageStats(db, { excludeLogins: ['someone'] });
    expect(await allRows()).toEqual(before);

    // Postgres refuses each write with read_only_sql_transaction (25006); drizzle keeps it as the cause.
    const refusal = (write: Promise<unknown>) => write.then(() => null, (error: { cause?: { code?: string } }) => error.cause?.code);
    expect(await refusal(readOnly(db, (tx) => tx.insert(users).values({ githubId: 77, login: 'x' })))).toBe('25006');
    expect(await refusal(readOnly(db, (tx) => tx.update(projects).set({ name: 'x' })))).toBe('25006');
    expect(await refusal(readOnly(db, (tx) => tx.delete(scans)))).toBe('25006');
    expect(await allRows()).toEqual(before);
  });
});

describe('the stats command', () => {
  it('takes repeated --exclude-login values and rejects anything else', () => {
    expect(parseCommand([])).toEqual({ excludeLogins: [] });
    expect(parseCommand(['--exclude-login', 'a', '--exclude-login', 'b'])).toEqual({ excludeLogins: ['a', 'b'] });
    expect(parseCommand(['--exclude-login', ' '])).toHaveProperty('error');
    expect(parseCommand(['--login', 'a'])).toHaveProperty('error');
    expect(parseCommand(['--confirm'])).toHaveProperty('error');
  });

  it('prints counts only: no login, name or repository, not even the excluded logins', async () => {
    await activeUser('secretlogin', { scanDays: 1 });
    await activeUser('operator', { scanDays: 1 });
    const text = formatStats(await usageStats(db, { excludeLogins: ['operator'] }), 1);
    expect(text).toMatch(/^users +1 +1 +1$/m);
    expect(text).toMatch(/^weekly active projects +1/m);
    expect(text).toContain('Left out: the demo and dev users, and 1 user matching 1 --exclude-login value.');
    expect(text).not.toMatch(/secretlogin|operator|acme|-app/);
  });
});

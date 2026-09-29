import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { alerts, clients, deploys, endpointDailyStats, endpoints, findings, projects, scans, scanVariables, users } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

async function makeDeploy(projectId: string, sha = 'abc123') {
  const [deploy] = await db
    .insert(deploys)
    .values({ projectId, sha, branch: 'main', deployedAt: new Date('2026-09-01T12:00:00Z') })
    .returning();
  return deploy!;
}

describe('schema', () => {
  it('creates every table from the migrations', async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      'alerts',
      'check_hosts',
      'checks',
      'clients',
      'deploys',
      'endpoint_daily_stats',
      'endpoints',
      'findings',
      'projects',
      'scan_variables',
      'scans',
      'users',
    ]);
  });

  it('defaults deploy source to ingest', async () => {
    const user = await makeUser(db);
    const project = await makeProject(db, user.id);
    expect((await makeDeploy(project.id)).source).toBe('ingest');
  });

  it('cascades a user delete down to findings', async () => {
    const user = await makeUser(db);
    const project = await makeProject(db, user.id);
    const deploy = await makeDeploy(project.id);
    const [scan] = await db
      .insert(scans)
      .values({ deployId: deploy.id, missingCount: 1, unusedCount: 0, mismatchCount: 0 })
      .returning();
    await db.insert(findings).values({ scanId: scan!.id, kind: 'missing', varName: 'API_KEY', file: 'src/a.ts', line: 3 });

    await db.delete(users).where(eq(users.id, user.id));

    for (const table of [projects, deploys, scans, findings]) {
      expect(await db.select().from(table)).toEqual([]);
    }
  });

  it('allows one deploy per sha per project, but the same sha in another project', async () => {
    const user = await makeUser(db);
    const a = await makeProject(db, user.id, 'a');
    const b = await makeProject(db, user.id, 'b');
    await makeDeploy(a.id, 'deadbeef');
    await expect(makeDeploy(a.id, 'deadbeef')).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(makeDeploy(b.id, 'deadbeef')).resolves.toBeTruthy();
  });

  it('keeps an alert but clears related_deploy_id when its deploy is deleted', async () => {
    const user = await makeUser(db);
    const project = await makeProject(db, user.id);
    const deploy = await makeDeploy(project.id);
    const [alert] = await db
      .insert(alerts)
      .values({ projectId: project.id, kind: 'endpoint_down', message: 'down', relatedDeployId: deploy.id })
      .returning();

    await db.delete(deploys).where(eq(deploys.id, deploy.id));

    const [after] = await db.select().from(alerts).where(eq(alerts.id, alert!.id));
    expect(after?.relatedDeployId).toBeNull();
  });

  it('rejects unknown finding kinds and duplicate token hashes', async () => {
    const user = await makeUser(db);
    const project = await makeProject(db, user.id);
    const deploy = await makeDeploy(project.id);
    const [scan] = await db
      .insert(scans)
      .values({ deployId: deploy.id, missingCount: 0, unusedCount: 0, mismatchCount: 0 })
      .returning();

    // Drizzle wraps driver errors; the Postgres error (with its SQLSTATE code) is the cause.
    await expect(
      db.execute(sql`insert into findings (scan_id, kind, var_name) values (${scan!.id}, 'bogus', 'X')`),
    ).rejects.toMatchObject({ cause: { code: '22P02' } }); // invalid_text_representation

    await expect(
      db.insert(projects).values({
        ownerId: user.id,
        name: 'copy',
        repoFullName: 'acme/copy',
        apiTokenHash: project.apiTokenHash,
        apiTokenHint: 'x',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } }); // unique_violation
  });

  it('keeps client slugs unique per user only', async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);
    await makeClient(db, a.id, 'Acme');
    await expect(makeClient(db, a.id, 'Acme')).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(makeClient(db, b.id, 'Acme')).resolves.toBeTruthy();
  });

  it('unassigns projects when their client is deleted, and deletes clients with their user', async () => {
    const user = await makeUser(db);
    const client = await makeClient(db, user.id);
    const project = await makeProject(db, user.id);
    await db.update(projects).set({ clientId: client.id }).where(eq(projects.id, project.id));

    await db.delete(clients).where(eq(clients.id, client.id));
    const [after] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(after?.clientId).toBeNull();

    await makeClient(db, user.id);
    await db.delete(users).where(eq(users.id, user.id));
    expect(await db.select().from(clients)).toEqual([]);
  });

  it('defaults new endpoints to due now with no failures', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const before = Date.now();
    const endpoint = await makeEndpoint(db, project.id);
    expect(endpoint).toMatchObject({ method: 'GET', intervalSeconds: 60, expectedStatus: 200, enabled: true, consecutiveFailures: 0 });
    expect(endpoint.nextCheckAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('rejects invalid endpoint intervals, methods and expected statuses', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    for (const bad of [{ intervalSeconds: 120 }, { expectedStatus: 700 }]) {
      await expect(makeEndpoint(db, project.id, bad)).rejects.toMatchObject({ cause: { code: '23514' } }); // check_violation
    }
    await expect(
      db.execute(sql`insert into endpoints (project_id, url, method) values (${project.id}, 'https://x.dev', 'POST')`),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('allows only one open alert per endpoint', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const endpoint = await makeEndpoint(db, project.id);
    const open = { projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'down' };
    const [first] = await db.insert(alerts).values(open).returning();
    await expect(db.insert(alerts).values(open)).rejects.toMatchObject({ cause: { code: '23505' } });

    await db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, first!.id));
    await expect(db.insert(alerts).values(open)).resolves.toBeTruthy();
  });

  it('limits endpoint names to 60 non-blank characters', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    await expect(makeEndpoint(db, project.id, { name: 'Acme API' })).resolves.toMatchObject({ name: 'Acme API' });
    await expect(makeEndpoint(db, project.id, { name: 'x'.repeat(60) })).resolves.toBeTruthy();
    await expect(makeEndpoint(db, project.id, { name: 'x'.repeat(61) })).rejects.toMatchObject({ cause: { code: '22001' } }); // string_data_right_truncation
    await expect(makeEndpoint(db, project.id, { name: '   ' })).rejects.toMatchObject({ cause: { code: '23514' } });
    expect((await makeEndpoint(db, project.id)).name).toBeNull();
  });

  it('caps deploy notes at 20,000 characters', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    await db.update(projects).set({ deployNotes: 'x'.repeat(20_000) }).where(eq(projects.id, project.id));
    await expect(
      db.update(projects).set({ deployNotes: 'x'.repeat(20_001) }).where(eq(projects.id, project.id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('stores scan variables per scope and deletes them with their scan', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const deploy = await makeDeploy(project.id, 'cafe01');
    const [scan] = await db.insert(scans).values({ deployId: deploy.id, missingCount: 0, unusedCount: 0, mismatchCount: 0 }).returning();
    await db.insert(scanVariables).values([
      { scanId: scan!.id, scope: '', varName: 'DATABASE_URL', definedIn: ['.env.example'] },
      { scanId: scan!.id, scope: 'apps/web', varName: 'DATABASE_URL' },
    ]);
    expect((await db.select().from(scanVariables)).map((v) => v.definedIn)).toEqual([['.env.example'], []]);
    await expect(db.insert(scanVariables).values({ scanId: scan!.id, scope: '', varName: 'DATABASE_URL' })).rejects.toMatchObject({
      cause: { code: '23505' },
    });
    await db.delete(scans).where(eq(scans.id, scan!.id));
    expect(await db.select().from(scanVariables)).toEqual([]);
  });

  it('keeps one daily stat per endpoint and day, with ok never above checks', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const endpoint = await makeEndpoint(db, project.id);
    await db.insert(endpointDailyStats).values({ endpointId: endpoint.id, day: '2026-09-01', checks: 1440, ok: 1439 });
    await expect(
      db.insert(endpointDailyStats).values({ endpointId: endpoint.id, day: '2026-09-01', checks: 1, ok: 1 }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      db.insert(endpointDailyStats).values({ endpointId: endpoint.id, day: '2026-09-02', checks: 1, ok: 2 }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await db.delete(endpoints).where(eq(endpoints.id, endpoint.id));
    expect(await db.select().from(endpointDailyStats)).toEqual([]);
  });
});

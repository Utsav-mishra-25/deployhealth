import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { alerts, deploys, findings, projects, scans, users } from '../src/schema';
import { makeProject, makeUser, openTestDb, truncateAll } from './test-db';

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
      'checks',
      'deploys',
      'endpoints',
      'findings',
      'projects',
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
});

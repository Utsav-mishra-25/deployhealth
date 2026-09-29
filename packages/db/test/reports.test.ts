import { parseMonth, reportTotals, summaryLine, type FindingRow } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getClientReport } from '../src/reports';
import { recordScan } from '../src/queries';
import { alerts, checks, endpointDailyStats, projects } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;
const SEPTEMBER = parseMonth('2026-09')!;
const OCT_5 = new Date('2026-10-05T09:00:00Z');
const at = (iso: string) => new Date(iso);
const missing = (var_name: string): FindingRow => ({ kind: 'missing', var_name, file: 'src/x.ts', line: 1, env_file: null });
const unused = (var_name: string): FindingRow => ({ kind: 'unused', var_name, file: '.env.example', line: 1, env_file: '.env.example' });

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

async function assign(projectId: string, clientId: string) {
  await db.update(projects).set({ clientId }).where(eq(projects.id, projectId));
}

/** Rolled-up September days for an endpoint: `days` days of `checks`, `failed` failures in total. */
async function septemberStats(endpointId: string, days: number, checksPerDay: number, failed: number) {
  await db.insert(endpointDailyStats).values(
    Array.from({ length: days }, (_, i) => ({
      endpointId,
      day: `2026-09-${String(i + 1).padStart(2, '0')}`,
      checks: checksPerDay,
      ok: checksPerDay - (i === 0 ? failed : 0),
    })),
  );
}

/**
 * A fixture September for client Acme with three projects:
 * - shop: one endpoint up all month (100%), ten deploys; an August deploy with LOG_LEVEL missing
 *   and OLD_KEY unused, which September's deploys fix one at a time (2 fixed), introducing REDIS_URL.
 * - api: one endpoint at 99.88% (12 failures in 10,000 checks) with one 21-minute incident, and
 *   four deploys.
 * - docs: no endpoints, no deploys.
 * So: "3 projects, 99.94% uptime, 1 incident (21m), 14 deploys, 2 config issues fixed".
 */
async function acmeSeptember() {
  const user = await makeUser(db);
  const acme = await makeClient(db, user.id, 'Acme Corp');
  const shop = await makeProject(db, user.id, 'shop');
  const api = await makeProject(db, user.id, 'api');
  const docs = await makeProject(db, user.id, 'docs');
  for (const p of [shop, api, docs]) await assign(p.id, acme.id);

  const shopHealth = await makeEndpoint(db, shop.id, { name: 'Shop' });
  const apiHealth = await makeEndpoint(db, api.id, { name: 'Acme API' });
  await septemberStats(shopHealth.id, 30, 1440, 0);
  await septemberStats(apiHealth.id, 10, 1000, 12);

  // Outside September: must not count.
  await db.insert(checks).values({ endpointId: apiHealth.id, checkedAt: at('2026-10-02T10:00:00Z'), statusCode: 503, latencyMs: 20, ok: false, error: 'x' });
  await db.insert(alerts).values([
    { projectId: api.id, endpointId: apiHealth.id, kind: 'endpoint_down', message: 'August outage', createdAt: at('2026-08-30T10:00:00Z'), resolvedAt: at('2026-08-30T11:00:00Z') },
    { projectId: api.id, endpointId: apiHealth.id, kind: 'endpoint_down', message: 'Acme API started failing; no deploy in the 30 minutes before the first failure', createdAt: at('2026-09-12T10:00:00Z'), resolvedAt: at('2026-09-12T10:21:00Z') },
    { projectId: api.id, endpointId: apiHealth.id, kind: 'endpoint_down', message: 'October outage', createdAt: at('2026-10-02T10:00:00Z'), resolvedAt: at('2026-10-02T10:05:00Z') },
  ]);

  const scan = (projectId: string, sha: string, iso: string, found: FindingRow[]) =>
    recordScan(db, { projectId, sha, branch: 'main', deployedAt: at(iso), findings: found });
  await scan(shop.id, 'a0000001', '2026-08-28T12:00:00Z', [missing('LOG_LEVEL'), unused('OLD_KEY')]);
  await scan(shop.id, 'a0000002', '2026-09-02T12:00:00Z', [missing('LOG_LEVEL')]); // fixed OLD_KEY
  for (let day = 3; day <= 10; day++) await scan(shop.id, `a00000${day + 10}`, `2026-09-${String(day).padStart(2, '0')}T12:00:00Z`, [missing('LOG_LEVEL')]);
  await scan(shop.id, 'a0000099', '2026-09-20T12:00:00Z', [missing('REDIS_URL')]); // fixed LOG_LEVEL, introduced REDIS_URL
  for (let day = 1; day <= 4; day++) await scan(api.id, `b000000${day}`, `2026-09-1${day}T08:00:00Z`, []);
  await scan(api.id, 'b0000099', '2026-10-01T08:00:00Z', [missing('ANALYTICS_KEY')]); // October: not in the report

  return { user, acme, shop, api, docs };
}

describe('getClientReport', () => {
  it('produces the exact summary line for a fixture month', async () => {
    const { acme } = await acmeSeptember();
    const report = await getClientReport(db, acme.id, SEPTEMBER, OCT_5);
    expect(summaryLine(reportTotals(report!))).toBe('3 projects, 99.94% uptime, 1 incident (21m), 14 deploys, 2 config issues fixed');
  });

  it('breaks the month down per project: endpoints, incidents, deploy diffs and open findings', async () => {
    const { acme } = await acmeSeptember();
    const report = await getClientReport(db, acme.id, SEPTEMBER, OCT_5);
    expect(report?.client).toEqual({ id: acme.id, name: 'Acme Corp', contactEmail: null });
    expect(report?.month.key).toBe('2026-09');
    const [api, docs, shop] = report!.projects;
    expect([api?.name, docs?.name, shop?.name]).toEqual(['api', 'docs', 'shop']);

    expect(api?.endpoints).toEqual([{ label: 'Acme API', url: expect.any(String), checks: 10_000, ok: 9_988, uptime: 0.9988 }]);
    expect(api?.incidents).toEqual([
      {
        endpoint: 'Acme API',
        openedAt: at('2026-09-12T10:00:00Z'),
        resolvedAt: at('2026-09-12T10:21:00Z'),
        durationMs: 21 * 60_000,
        message: 'Acme API started failing; no deploy in the 30 minutes before the first failure',
      },
    ]);
    expect(api?.deploys).toHaveLength(4);
    // api's first deploy ever is in September: nothing to fix, nothing introduced (no findings).
    expect(api?.deploys[0]).toMatchObject({ introduced: [], fixed: [] });
    // Open findings are as of now (October's scan), not September's.
    expect(api?.openFindings.map((f) => f.var_name)).toEqual(['ANALYTICS_KEY']);

    expect(docs).toMatchObject({ endpoints: [], incidents: [], deploys: [], openFindings: [] });

    expect(shop?.deploys).toHaveLength(10);
    expect(shop?.deploys[0]).toMatchObject({ sha: 'a0000002', introduced: [], fixed: [{ kind: 'unused', var_name: 'OLD_KEY' }] });
    expect(shop?.deploys[9]).toMatchObject({
      sha: 'a0000099',
      introduced: [{ kind: 'missing', var_name: 'REDIS_URL' }],
      fixed: [{ kind: 'missing', var_name: 'LOG_LEVEL' }],
    });
    expect(shop?.endpoints[0]?.uptime).toBe(1);
  });

  it('counts a month in progress up to now, including an incident that is still open', async () => {
    const user = await makeUser(db);
    const client = await makeClient(db, user.id, 'Now Co');
    const project = await makeProject(db, user.id);
    await assign(project.id, client.id);
    const endpoint = await makeEndpoint(db, project.id);
    await db.insert(checks).values([
      { endpointId: endpoint.id, checkedAt: at('2026-09-28T10:00:00Z'), statusCode: 200, latencyMs: 20, ok: true, error: null },
      { endpointId: endpoint.id, checkedAt: at('2026-09-28T11:00:00Z'), statusCode: 503, latencyMs: 20, ok: false, error: 'x' },
    ]);
    await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'down', createdAt: at('2026-09-28T11:30:00Z') });
    const report = await getClientReport(db, client.id, SEPTEMBER, at('2026-09-28T12:00:00Z'));
    expect(report?.projects[0]?.endpoints[0]).toMatchObject({ checks: 2, ok: 1, uptime: 0.5 });
    expect(report?.projects[0]?.incidents[0]).toMatchObject({ resolvedAt: null, durationMs: 30 * 60_000 });
    expect(summaryLine(reportTotals(report!))).toBe('1 project, 50.00% uptime, 1 incident (30m), 0 deploys, no config issues fixed');
  });

  it('returns null for an unknown client', async () => {
    expect(await getClientReport(db, '0d3e0000-0000-4000-8000-000000000000', SEPTEMBER, OCT_5)).toBeNull();
  });
});

describe("a report for client A never reveals client B", () => {
  it("leaves out the same owner's other clients, unassigned projects and other users", async () => {
    const { user, acme } = await acmeSeptember();

    // Client B, same owner: its own project, endpoint, alert and findings.
    const beta = await makeClient(db, user.id, 'Beta Secret Client');
    const betaProject = await makeProject(db, user.id, 'beta-secret-project');
    await assign(betaProject.id, beta.id);
    const betaEndpoint = await makeEndpoint(db, betaProject.id, { name: 'Beta secret endpoint', url: 'https://beta-secret.example/health' });
    await db.insert(alerts).values({ projectId: betaProject.id, endpointId: betaEndpoint.id, kind: 'endpoint_down', message: 'beta secret outage', createdAt: at('2026-09-15T10:00:00Z') });
    await recordScan(db, { projectId: betaProject.id, sha: 'c0000001', branch: 'main', deployedAt: at('2026-09-15T09:00:00Z'), findings: [missing('BETA_SECRET_VAR')] });
    // An unassigned project of the same owner, and another user's client and project.
    await makeProject(db, user.id, 'beta-secret-unassigned');
    const stranger = await makeUser(db);
    const strangerClient = await makeClient(db, stranger.id, 'Beta Secret Stranger');
    const strangerProject = await makeProject(db, stranger.id, 'beta-secret-stranger-project');
    await assign(strangerProject.id, strangerClient.id);

    const report = await getClientReport(db, acme.id, SEPTEMBER, OCT_5);
    const serialized = JSON.stringify(report).toLowerCase();
    expect(report?.projects.map((p) => p.name)).toEqual(['api', 'docs', 'shop']);
    expect(serialized).not.toContain('beta');
    expect(serialized).not.toContain(betaProject.id);

    // And B's own report is B's.
    const betaReport = await getClientReport(db, beta.id, SEPTEMBER, OCT_5);
    expect(betaReport?.projects.map((p) => p.name)).toEqual(['beta-secret-project']);
    expect(JSON.stringify(betaReport)).not.toContain('Acme');
  });

  it("ignores a project pointed at the client by another user", async () => {
    const { acme } = await acmeSeptember();
    const intruder = await makeUser(db);
    const planted = await makeProject(db, intruder.id, 'planted');
    // The app never allows this (assignment checks ownership); the query must not trust it either.
    await db.update(projects).set({ clientId: acme.id }).where(eq(projects.id, planted.id));
    const report = await getClientReport(db, acme.id, SEPTEMBER, OCT_5);
    expect(report?.projects.map((p) => p.name)).toEqual(['api', 'docs', 'shop']);
  });
});

import type { FindingRow } from '@deployhealth/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listDeployHistory } from '../src/deploy-history';
import { recordCheck, type CheckOutcome } from '../src/monitoring';
import { recordScan } from '../src/queries';
import { alerts, checks, deploys } from '../src/schema';
import { makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const T0 = new Date('2026-09-01T00:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const ok = (at: Date): CheckOutcome => ({ checkedAt: at, statusCode: 200, latencyMs: 90, ok: true, error: null });
const fail = (at: Date): CheckOutcome => ({ checkedAt: at, statusCode: 503, latencyMs: 30, ok: false, error: 'Expected 200, got 503' });

const missing = (name: string): FindingRow => ({ kind: 'missing', var_name: name, file: 'src/a.ts', line: 1, env_file: null });
const unused = (name: string): FindingRow => ({ kind: 'unused', var_name: name, file: '.env.example', line: 1, env_file: '.env.example' });

async function setup() {
  const owner = await makeUser(db);
  const project = await makeProject(db, owner.id, 'shop', 'acme/shop');
  const scan = (sha: string, at: Date, findings: FindingRow[]) => recordScan(db, { projectId: project.id, sha, branch: 'main', deployedAt: at, findings });
  return { owner, project, scan };
}

describe('listDeployHistory: what each deploy changed', () => {
  it('first deploy, added, fixed, no change and an unscanned deploy, compared with the previous scanned deploy', async () => {
    const { owner, project, scan } = await setup();
    await scan('a000001', minutes(0), [missing('DB_URL'), unused('OLD_FLAG')]);
    await scan('a000002', minutes(10), [missing('DB_URL'), missing('REDIS_URL'), unused('OLD_FLAG')]);
    await scan('a000003', minutes(20), [missing('DB_URL'), missing('REDIS_URL')]);
    // A deploy with no scan (e.g. a later re-report that failed): it's skipped when comparing.
    await db.insert(deploys).values({ projectId: project.id, sha: 'a000004', branch: 'main', deployedAt: minutes(30) });
    await scan('a000005', minutes(40), [missing('DB_URL'), missing('REDIS_URL')]);

    const history = await listDeployHistory(db, owner.id, project.id);
    expect(history.map((h) => h.deploy.sha)).toEqual(['a000005', 'a000004', 'a000003', 'a000002', 'a000001']);
    expect(history.map((h) => h.change)).toEqual([
      { kind: 'diff', introduced: [], fixed: [] },
      { kind: 'unscanned' },
      { kind: 'diff', introduced: [], fixed: [{ kind: 'unused', var_name: 'OLD_FLAG' }] },
      { kind: 'diff', introduced: [{ kind: 'missing', var_name: 'REDIS_URL' }], fixed: [] },
      { kind: 'first' },
    ]);
    expect(history[0]).toMatchObject({ counts: { missing: 2, unused: 0, mismatch: 0 }, scanCount: 1, outage: null });
    expect(history[1]).toMatchObject({ counts: null, scanCount: 0 });
  });

  it("compares a deploy's latest scan, so a re-scan of the same sha replaces the first", async () => {
    const { owner, project, scan } = await setup();
    await scan('b000001', minutes(0), []);
    await scan('b000002', minutes(10), [missing('A')]);
    await scan('b000002', minutes(10), []); // the re-run fixed it
    const [latest] = await listDeployHistory(db, owner.id, project.id);
    expect(latest).toMatchObject({ scanCount: 2, change: { kind: 'diff', introduced: [], fixed: [] } });
  });

  it('compares the oldest row on the page with the scanned deploy before it, off the page', async () => {
    const { owner, project, scan } = await setup();
    await scan('c000001', minutes(0), [missing('A')]);
    await db.insert(deploys).values({ projectId: project.id, sha: 'c000002', branch: 'main', deployedAt: minutes(5) });
    await scan('c000003', minutes(10), [missing('A'), missing('B')]);
    await scan('c000004', minutes(20), [missing('A'), missing('B')]);

    const page = await listDeployHistory(db, owner.id, project.id, 2);
    expect(page.map((h) => h.deploy.sha)).toEqual(['c000004', 'c000003']);
    expect(page[1]!.change).toEqual({ kind: 'diff', introduced: [{ kind: 'missing', var_name: 'B' }], fixed: [] });
  });
});

describe('listDeployHistory: the outage after a deploy', () => {
  it('marks the deploy before an outage, measured from its first failed check, resolved or not', async () => {
    const { owner, project, scan } = await setup();
    const endpoint = await makeEndpoint(db, project.id, { name: 'Shop API' });
    await recordCheck(db, endpoint.id, ok(minutes(-5)));
    await scan('d000001', minutes(0), []);
    await scan('d000002', minutes(60), [missing('REDIS_URL')]);
    // Fails from 14 minutes after d000002; the alert opens on the second failure.
    await recordCheck(db, endpoint.id, ok(minutes(70)));
    await recordCheck(db, endpoint.id, fail(minutes(74)));
    await recordCheck(db, endpoint.id, fail(minutes(75)));

    let history = await listDeployHistory(db, owner.id, project.id);
    expect(history[0]!.outage).toEqual({ startedAt: minutes(74), resolvedAt: null, endpoint: 'Shop API', more: 0 });
    expect(history[1]!.outage).toBeNull();

    // The first ok isn't recovery yet; the second resolves it.
    await recordCheck(db, endpoint.id, ok(minutes(95)));
    await recordCheck(db, endpoint.id, ok(minutes(96)));
    history = await listDeployHistory(db, owner.id, project.id);
    expect(history[0]!.outage).toEqual({ startedAt: minutes(74), resolvedAt: minutes(96), endpoint: 'Shop API', more: 0 });
  });

  it('puts an outage under the deploy it followed, not the next one, and counts further outages in the window', async () => {
    const { owner, project, scan } = await setup();
    const api = await makeEndpoint(db, project.id);
    const web = await makeEndpoint(db, project.id, { name: 'Web' });
    await scan('e000001', minutes(0), []);
    await scan('e000002', minutes(100), []);
    for (const endpoint of [api, web]) await recordCheck(db, endpoint.id, ok(minutes(1)));
    await recordCheck(db, web.id, fail(minutes(20)));
    await recordCheck(db, web.id, fail(minutes(21)));
    await recordCheck(db, api.id, fail(minutes(30)));
    await recordCheck(db, api.id, fail(minutes(31)));

    const [newer, older] = await listDeployHistory(db, owner.id, project.id);
    expect(newer!.outage).toBeNull();
    expect(older!.outage).toMatchObject({ startedAt: minutes(20), endpoint: 'Web', more: 1 });
  });

  it("uses the alert's open time once its checks are pruned, and ignores outages that began before a deploy", async () => {
    const { owner, project, scan } = await setup();
    const endpoint = await makeEndpoint(db, project.id, { name: 'API' });
    await scan('f000001', minutes(0), []);
    await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'down', createdAt: minutes(9) });
    expect((await listDeployHistory(db, owner.id, project.id))[0]!.outage).toMatchObject({ startedAt: minutes(9) });

    // A run that started before the deploy and alerted after it belongs to an earlier deploy.
    await truncateAll(db);
    const again = await setup();
    const ep = await makeEndpoint(db, again.project.id);
    await recordCheck(db, ep.id, ok(minutes(-10)));
    await recordCheck(db, ep.id, fail(minutes(-1)));
    await again.scan('f000002', minutes(0), []);
    await recordCheck(db, ep.id, fail(minutes(1)));
    expect(await db.select().from(alerts)).toHaveLength(1);
    expect(await db.select().from(checks)).toHaveLength(3);
    expect((await listDeployHistory(db, again.owner.id, again.project.id))[0]!.outage).toBeNull();
  });
});

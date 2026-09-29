import { failingFor, type FindingRow } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimDueEndpoints,
  getProjectMonitoring,
  listOpenAlerts,
  pruneChecks,
  recordCheck,
  type CheckOutcome,
} from '../src/monitoring';
import { listProjectsForOwner, recordScan } from '../src/queries';
import { alerts, checks, endpoints, projects } from '../src/schema';
import { makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const T0 = new Date('2026-09-28T12:00:00Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const ok = (at: Date): CheckOutcome => ({ checkedAt: at, statusCode: 200, latencyMs: 120, ok: true, error: null });
const fail = (at: Date): CheckOutcome => ({ checkedAt: at, statusCode: 503, latencyMs: 80, ok: false, error: 'Expected 200, got 503' });
const missing = (var_name: string): FindingRow => ({ kind: 'missing', var_name, file: 'src/x.ts', line: 1, env_file: null });

async function setup() {
  const user = await makeUser(db);
  const project = await makeProject(db, user.id, 'shop');
  const endpoint = await makeEndpoint(db, project.id, { url: 'https://api.acme.com/health' });
  return { user, project, endpoint };
}

describe('claimDueEndpoints (scheduling query)', () => {
  it('claims enabled, due endpoints and moves next_check_at forward by their interval', async () => {
    const user = await makeUser(db);
    const p = await makeProject(db, user.id);
    const due60 = await makeEndpoint(db, p.id, { nextCheckAt: minutes(-1), intervalSeconds: 60 });
    const due300 = await makeEndpoint(db, p.id, { nextCheckAt: minutes(0), intervalSeconds: 300 });
    await makeEndpoint(db, p.id, { nextCheckAt: minutes(5) }); // not due yet
    await makeEndpoint(db, p.id, { nextCheckAt: minutes(-10), enabled: false }); // disabled

    const claimed = await claimDueEndpoints(db, { now: T0 });
    expect(claimed.map((e) => e.id).sort()).toEqual([due60.id, due300.id].sort());

    const rows = await db.select().from(endpoints);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(due60.id)?.nextCheckAt).toEqual(minutes(1));
    expect(byId.get(due300.id)?.nextCheckAt).toEqual(minutes(5));

    // Claimed endpoints are no longer due at the same instant.
    expect(await claimDueEndpoints(db, { now: T0 })).toEqual([]);
    // One minute later the 60s endpoint is due again.
    expect((await claimDueEndpoints(db, { now: minutes(1) })).map((e) => e.id)).toEqual([due60.id]);
  });

  it('respects the limit, oldest first, and never hands the same endpoint to two workers', async () => {
    const user = await makeUser(db);
    const p = await makeProject(db, user.id);
    const created = [];
    for (let i = 0; i < 6; i++) created.push(await makeEndpoint(db, p.id, { nextCheckAt: minutes(-10 + i) }));

    // The two oldest are claimed (RETURNING order is unspecified, so compare as sets).
    const firstBatch = (await claimDueEndpoints(db, { now: T0, limit: 2 })).map((e) => e.id).sort();
    expect(firstBatch).toEqual([created[0]!.id, created[1]!.id].sort());

    const second = openTestDb();
    try {
      const [a, b] = await Promise.all([
        claimDueEndpoints(db, { now: T0, limit: 10 }),
        claimDueEndpoints(second.db, { now: T0, limit: 10 }),
      ]);
      const ids = [...a, ...b].map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.sort()).toEqual(created.slice(2).map((e) => e.id).sort());
    } finally {
      await second.close();
    }
  });
});

describe('recordCheck and the alert lifecycle', () => {
  it('opens on the second consecutive failure after an ok check and resolves on the next ok', async () => {
    const { endpoint, project } = await setup();

    expect((await recordCheck(db, endpoint.id, ok(minutes(0)))).event).toBeNull();
    expect(await recordCheck(db, endpoint.id, fail(minutes(1)))).toEqual({ consecutiveFailures: 1, event: null });

    const opened = await recordCheck(db, endpoint.id, fail(minutes(2)));
    expect(opened.consecutiveFailures).toBe(2);
    expect(opened.event).toMatchObject({
      type: 'opened',
      projectId: project.id,
      projectName: 'shop',
      webhookUrl: null,
      message: 'api.acme.com started failing; no deploy in the 30 minutes before the first failure',
    });

    // Still failing: no second alert, no event.
    expect(await recordCheck(db, endpoint.id, fail(minutes(3)))).toEqual({ consecutiveFailures: 3, event: null });
    expect(await db.select().from(alerts)).toHaveLength(1);

    const resolved = await recordCheck(db, endpoint.id, ok(minutes(4)));
    expect(resolved).toMatchObject({
      consecutiveFailures: 0,
      event: { type: 'resolved', alertId: opened.event!.alertId, message: 'api.acme.com is back up (alert open for 2m)' },
    });
    const [alert] = await db.select().from(alerts);
    expect(alert).toMatchObject({ endpointId: endpoint.id, kind: 'endpoint_down', createdAt: minutes(2), resolvedAt: minutes(4) });
    expect(await db.select().from(checks)).toHaveLength(5);
  });

  it('never alerts for an endpoint that has never been ok', async () => {
    const { endpoint } = await setup();
    for (let i = 0; i < 4; i++) expect((await recordCheck(db, endpoint.id, fail(minutes(i)))).event).toBeNull();
    expect(await db.select().from(alerts)).toEqual([]);
  });

  it('links the latest deploy within 30 minutes of the first failure and lists new MISSING vars', async () => {
    const { endpoint, project } = await setup();
    await db.update(projects).set({ alertWebhookUrl: 'https://hooks.slack.com/services/x' }).where(eq(projects.id, project.id));
    await recordScan(db, { projectId: project.id, sha: 'aaaaaaa', branch: 'main', deployedAt: minutes(-120), findings: [missing('OLD_ONE')] });
    const linked = await recordScan(db, {
      projectId: project.id,
      sha: 'b52952e8192c38c054e53b5447ea20de88f2e2e9',
      branch: 'main',
      deployedAt: minutes(-4),
      findings: [missing('OLD_ONE'), missing('STRIPE_KEY'), missing('REDIS_URL'), missing('REDIS_URL')],
    });

    await recordCheck(db, endpoint.id, ok(minutes(-10)));
    await recordCheck(db, endpoint.id, fail(minutes(0)));
    const { event } = await recordCheck(db, endpoint.id, fail(minutes(1)));

    expect(event).toMatchObject({
      type: 'opened',
      webhookUrl: 'https://hooks.slack.com/services/x',
      message: 'api.acme.com started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
    });
    const [alert] = await db.select().from(alerts);
    expect(alert?.relatedDeployId).toBe(linked.deployId);

    const banner = await listOpenAlerts(db, (await db.select().from(projects))[0]!.ownerId, project.id);
    expect(banner).toMatchObject([{ endpointUrl: 'https://api.acme.com/health', deploy: { id: linked.deployId } }]);
  });

  it('says the linked deploy had no new findings when nothing new is missing', async () => {
    const { endpoint, project } = await setup();
    await recordScan(db, { projectId: project.id, sha: 'aaaaaaa', branch: 'main', deployedAt: minutes(-60), findings: [missing('A')] });
    await recordScan(db, { projectId: project.id, sha: 'bbbbbbb', branch: 'main', deployedAt: minutes(-15), findings: [missing('A')] });
    await recordCheck(db, endpoint.id, ok(minutes(-20)));
    await recordCheck(db, endpoint.id, fail(minutes(0)));
    const { event } = await recordCheck(db, endpoint.id, fail(minutes(1)));
    expect(event?.message).toBe('api.acme.com started failing 15m after deploy bbbbbbb, which had no new config findings');
  });

  it('ignores deploys older than 30 minutes or after the first failure', async () => {
    const { endpoint, project } = await setup();
    await recordScan(db, { projectId: project.id, sha: 'ccccccc', branch: 'main', deployedAt: minutes(-31), findings: [missing('X')] });
    await recordScan(db, { projectId: project.id, sha: 'ddddddd', branch: 'main', deployedAt: minutes(0.5), findings: [missing('Y')] });
    await recordCheck(db, endpoint.id, ok(minutes(-40)));
    await recordCheck(db, endpoint.id, fail(minutes(0)));
    const { event } = await recordCheck(db, endpoint.id, fail(minutes(1)));
    expect(event?.message).toContain('no deploy in the 30 minutes before the first failure');
    expect((await db.select().from(alerts))[0]?.relatedDeployId).toBeNull();
  });
});

describe('pruneChecks', () => {
  it('deletes only checks older than the cutoff', async () => {
    const { endpoint } = await setup();
    for (const at of [minutes(-60 * 24 * 31), minutes(-60 * 24 * 30 - 1), minutes(-60 * 24 * 29), minutes(0)]) {
      await db.insert(checks).values({ endpointId: endpoint.id, ...ok(at) });
    }
    expect(await pruneChecks(db, minutes(-60 * 24 * 30))).toBe(2);
    expect(await db.select().from(checks)).toHaveLength(2);
  });
});

describe('getProjectMonitoring', () => {
  it('computes status, uptime windows, hourly latency percentiles and recent checks', async () => {
    const { user, project, endpoint } = await setup();
    const now = minutes(0);
    // 3 days ago: one failure (counts toward 7d only).
    await db.insert(checks).values({ endpointId: endpoint.id, ...fail(minutes(-60 * 72)) });
    // Last hour: latencies 100..1000 (ok) plus one failure.
    for (let i = 1; i <= 10; i++) {
      await db.insert(checks).values({ endpointId: endpoint.id, ...ok(minutes(-i)), latencyMs: i * 100 });
    }
    await db.insert(checks).values({ endpointId: endpoint.id, ...fail(minutes(-30)) });
    const disabled = await makeEndpoint(db, project.id, { enabled: false });
    const fresh = await makeEndpoint(db, project.id);

    const result = await getProjectMonitoring(db, user.id, project.id, now);
    const main = result.find((r) => r.endpoint.id === endpoint.id)!;
    expect(main.status).toBe('up');
    expect(main.uptime24h).toBeCloseTo(10 / 11);
    expect(main.uptime7d).toBeCloseTo(10 / 12);
    expect(main.recent).toHaveLength(12);
    expect(main.recent[0]?.checkedAt).toEqual(minutes(-1));
    const latency = main.latency.reduce((sum, b) => sum + b.p50, 0);
    expect(latency).toBeGreaterThan(0);
    expect(main.latency.every((b) => b.p95 >= b.p50)).toBe(true);

    expect(result.find((r) => r.endpoint.id === disabled.id)?.status).toBe('paused');
    expect(result.find((r) => r.endpoint.id === fresh.id)).toMatchObject({ status: 'pending', uptime24h: null, recent: [] });
  });
});

describe('failingSince (the "Down for 21m" duration)', () => {
  const record = async (endpointId: string, outcomes: CheckOutcome[]) => {
    for (const outcome of outcomes) await recordCheck(db, endpointId, outcome);
  };
  const monitoringOf = async (userId: string, projectId: string, endpointId: string) =>
    (await getProjectMonitoring(db, userId, projectId, T0)).find((m) => m.endpoint.id === endpointId)!;

  it('starts at the first failed check of the current run, not an earlier one', async () => {
    const { user, project, endpoint } = await setup();
    await record(endpoint.id, [fail(minutes(-60)), ok(minutes(-50)), ok(minutes(-40)), fail(minutes(-21)), fail(minutes(-20)), fail(minutes(-10))]);

    const down = await monitoringOf(user.id, project.id, endpoint.id);
    expect(down).toMatchObject({ status: 'down', failingSince: minutes(-21) });
    expect(failingFor('down', down.failingSince!, T0)).toBe('Down for 21m');

    await record(endpoint.id, [ok(minutes(-1))]);
    expect(await monitoringOf(user.id, project.id, endpoint.id)).toMatchObject({ status: 'up', failingSince: null });
  });

  it('covers failures that have not alerted, endpoints that never worked, and paused endpoints', async () => {
    const { user, project, endpoint } = await setup();
    await record(endpoint.id, [ok(minutes(-10)), fail(minutes(-3))]);
    expect(await monitoringOf(user.id, project.id, endpoint.id)).toMatchObject({ status: 'failing', failingSince: minutes(-3) });

    const broken = await makeEndpoint(db, project.id);
    await record(broken.id, [fail(minutes(-30)), fail(minutes(-20))]);
    expect(await monitoringOf(user.id, project.id, broken.id)).toMatchObject({ status: 'failing', failingSince: minutes(-30) });

    const paused = await makeEndpoint(db, project.id);
    await record(paused.id, [fail(minutes(-5))]);
    await db.update(endpoints).set({ enabled: false }).where(eq(endpoints.id, paused.id));
    expect(await monitoringOf(user.id, project.id, paused.id)).toMatchObject({ status: 'paused', failingSince: null });
  });

  it('gives each project row the failure behind its badge', async () => {
    const { user, project: shop, endpoint: api } = await setup();
    // shop: api is down (alert open) since -21; a second endpoint has never worked, since -300.
    await record(api.id, [ok(minutes(-40)), fail(minutes(-21)), fail(minutes(-20))]);
    const legacy = await makeEndpoint(db, shop.id);
    await record(legacy.id, [fail(minutes(-300)), fail(minutes(-200))]);
    // blog: one failing endpoint, no alert yet.
    const blog = await makeProject(db, user.id, 'blog');
    await record((await makeEndpoint(db, blog.id)).id, [ok(minutes(-10)), fail(minutes(-4))]);
    // docs: healthy.
    const docs = await makeProject(db, user.id, 'docs');
    await record((await makeEndpoint(db, docs.id)).id, [fail(minutes(-9)), ok(minutes(-8))]);

    const rows = Object.fromEntries((await listProjectsForOwner(db, user.id)).map((p) => [p.name, p]));
    expect(rows.shop).toMatchObject({ uptime: 'down', failingSince: minutes(-21) });
    expect(rows.blog).toMatchObject({ uptime: 'degraded', failingSince: minutes(-4) });
    expect(rows.docs).toMatchObject({ uptime: 'up', failingSince: null });
  });
});

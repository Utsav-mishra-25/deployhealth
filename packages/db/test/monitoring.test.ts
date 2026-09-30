import { failingFor, LimitExceededError, type FindingRow } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignHostSlots,
  claimDueEndpoints,
  createEndpoint,
  getProjectMonitoring,
  listOpenAlerts,
  pruneChecks,
  recordCheck,
  rollupChecks,
  updateEndpoint,
  type CheckOutcome,
} from '../src/monitoring';
import { listProjectsForOwner, recordScan } from '../src/queries';
import { alerts, checkHosts, checks, endpointDailyStats, endpoints, projects } from '../src/schema';
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

const seconds = (n: number) => new Date(T0.getTime() + n * 1000);

describe('assignHostSlots (pure)', () => {
  const e = (id: string, hostname: string) => ({ id, hostname });
  const offsets = (r: ReturnType<typeof assignHostSlots<{ id: string; hostname: string }>>) =>
    r.assigned.map((a) => `${a.id}@${(a.runAt.getTime() - T0.getTime()) / 1000}`);

  it('spaces checks of one hostname 10s apart, at most 5 per claim; other hosts start at once', () => {
    const due = [...'abcdefg'].map((id) => e(id, 'shared.example')).concat(e('x', 'other.example'));
    const r = assignHostSlots(due, new Map(), T0);
    expect(offsets(r)).toEqual(['a@0', 'b@10', 'c@20', 'd@30', 'e@40', 'x@0']);
    expect(r.nextFree).toEqual(new Map([['shared.example', seconds(50)], ['other.example', seconds(10)]]));
  });

  it("starts after the host's reserved slot, rounded up to the 10s wave grid", () => {
    const r = assignHostSlots([e('a', 'h'), e('b', 'h')], new Map([['h', seconds(23)]]), T0);
    expect(offsets(r)).toEqual(['a@30', 'b@40']);
    expect(assignHostSlots([e('a', 'h')], new Map([['h', seconds(-99)]]), T0).assigned[0]!.runAt).toEqual(T0);
    const busy = assignHostSlots([e('a', 'h')], new Map([['h', seconds(50)]]), T0);
    expect(busy.assigned).toEqual([]);
    expect(busy.nextFree.size).toBe(0);
  });
});

describe('claimDueEndpoints: host spacing across all users', () => {
  it('reads hostnames in SQL exactly as URL.hostname does', async () => {
    const user = await makeUser(db);
    const p = await makeProject(db, user.id);
    const urls = [
      'https://API.Example.COM/health',
      'http://example.org:8080/a?b=1#c',
      'https://example.net?q=1',
      'https://[2001:db8::1]:8443/status',
      'https://xn--bcher-kva.example/',
      'http://203.0.113.9/',
    ];
    for (const url of urls) await makeEndpoint(db, p.id, { url, nextCheckAt: minutes(-1) });
    const claimed = await claimDueEndpoints(db, { now: T0 });
    expect(new Map(claimed.map((c) => [c.url, c.hostname]))).toEqual(new Map(urls.map((u) => [u, new URL(u).hostname])));
  });

  it('checks a hostname shared by two users at most once per 10 seconds', async () => {
    const [alice, bob] = [await makeUser(db), await makeUser(db)];
    const [pa, pb] = [await makeProject(db, alice.id), await makeProject(db, bob.id)];
    const shared = [];
    for (let i = 0; i < 7; i++) {
      shared.push(await makeEndpoint(db, (i % 2 ? pb : pa).id, { url: `https://shared.example/${i}`, nextCheckAt: minutes(-10 + i) }));
    }
    const other = await makeEndpoint(db, pb.id, { url: 'https://other.example/', nextCheckAt: minutes(-1) });

    const first = await claimDueEndpoints(db, { now: T0 });
    const at = (list: typeof first, id: string) => list.find((c) => c.id === id)?.runAt;
    expect(shared.slice(0, 5).map((e) => at(first, e.id))).toEqual([0, 10, 20, 30, 40].map(seconds));
    expect(at(first, other.id)).toEqual(T0);
    expect(first).toHaveLength(6);
    // The next check is one interval after the slot, not after the claim.
    const [row] = await db.select().from(endpoints).where(eq(endpoints.id, shared[4]!.id));
    expect(row!.nextCheckAt).toEqual(seconds(40 + 60));
    expect(await db.select().from(checkHosts)).toEqual(
      expect.arrayContaining([
        { hostname: 'shared.example', nextSlotAt: seconds(50) },
        { hostname: 'other.example', nextSlotAt: seconds(10) },
      ]),
    );

    // A second claim at the same moment gets nothing: the host's slots in this window are taken.
    expect(await claimDueEndpoints(db, { now: T0 })).toEqual([]);
    // The next run continues the host's 10s grid: the two that waited go first, then the one
    // checked at T0, which is due again (60s interval).
    const next = await claimDueEndpoints(db, { now: minutes(1) });
    expect(new Map(next.map((c) => [c.id, c.runAt]))).toEqual(
      new Map([
        [shared[5]!.id, seconds(60)],
        [shared[6]!.id, seconds(70)],
        [shared[0]!.id, seconds(80)],
        [other.id, seconds(60)],
      ]),
    );
  });

  it('keeps the spacing when two workers claim at the same moment', async () => {
    const user = await makeUser(db);
    const p = await makeProject(db, user.id);
    for (let i = 0; i < 12; i++) await makeEndpoint(db, p.id, { url: `https://busy.example/${i}`, nextCheckAt: minutes(-1) });
    const second = openTestDb();
    try {
      const [a, b] = await Promise.all([claimDueEndpoints(db, { now: T0 }), claimDueEndpoints(second.db, { now: T0 })]);
      const starts = [...a, ...b].map((c) => c.runAt.getTime()).sort((x, y) => x - y);
      expect(new Set([...a, ...b].map((c) => c.id)).size).toBe(starts.length);
      expect(starts.map((t) => (t - T0.getTime()) / 1000)).toEqual([0, 10, 20, 30, 40]);
    } finally {
      await second.close();
    }
  });

  it('does not let one busy host crowd out the others', async () => {
    const user = await makeUser(db);
    const p = await makeProject(db, user.id);
    await db.insert(endpoints).values(Array.from({ length: 40 }, (_, i) => ({ projectId: p.id, url: `https://busy.example/${i}`, nextCheckAt: minutes(-30) })));
    const quiet = await makeEndpoint(db, p.id, { url: 'https://quiet.example/', nextCheckAt: minutes(-1) });
    const claimed = await claimDueEndpoints(db, { now: T0, limit: 6 });
    expect(claimed.map((c) => c.hostname).sort()).toEqual(['busy.example', 'busy.example', 'busy.example', 'busy.example', 'busy.example', 'quiet.example']);
    expect(claimed.find((c) => c.id === quiet.id)?.runAt).toEqual(T0);
  });
});

describe('createEndpoint: hard caps', () => {
  const input = { url: 'https://api.example.com/', method: 'GET' as const, intervalSeconds: 60 as const, expectedStatus: 200, enabled: true };
  const fill = (projectId: string, n: number) =>
    db.insert(endpoints).values(Array.from({ length: n }, (_, i) => ({ projectId, url: `https://fill.example/${i}` })));
  const limitOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'created',
      (error: unknown) => (error instanceof LimitExceededError ? error.limit : String(error)),
    );

  it('allows 100 endpoints in a project and refuses the 101st', async () => {
    const user = await makeUser(db);
    const p = await makeProject(db, user.id);
    await fill(p.id, 99);
    expect(await limitOf(createEndpoint(db, user.id, p.id, input))).toBe('created');
    expect(await limitOf(createEndpoint(db, user.id, p.id, input))).toBe('endpointsPerProject');
    await expect(createEndpoint(db, user.id, p.id, input)).rejects.toThrow('A project can have at most 100 endpoints.');
    // Other projects of the same user are unaffected.
    expect(await limitOf(createEndpoint(db, user.id, (await makeProject(db, user.id)).id, input))).toBe('created');
  });

  it('allows 500 endpoints across a user’s projects and refuses the 501st; other users are unaffected', async () => {
    const [user, other] = [await makeUser(db), await makeUser(db)];
    for (let i = 0; i < 5; i++) await fill((await makeProject(db, user.id)).id, 100);
    const sixth = await makeProject(db, user.id);
    expect(await limitOf(createEndpoint(db, user.id, sixth.id, input))).toBe('endpointsPerUser');
    expect(await db.$count(endpoints, eq(endpoints.projectId, sixth.id))).toBe(0);
    expect(await limitOf(createEndpoint(db, other.id, (await makeProject(db, other.id)).id, input))).toBe('created');
  });

  it('holds under concurrent creates: exactly one of two takes the last place', async () => {
    const user = await makeUser(db);
    const p = await makeProject(db, user.id);
    await fill(p.id, 99);
    const second = openTestDb();
    try {
      const results = await Promise.all([limitOf(createEndpoint(db, user.id, p.id, input)), limitOf(createEndpoint(second.db, user.id, p.id, input))]);
      expect(results.sort()).toEqual(['created', 'endpointsPerProject']);
      expect(await db.$count(endpoints, eq(endpoints.projectId, p.id))).toBe(100);
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

describe('deploy correlation for scopes with no env file (CLI 0.2.0+)', () => {
  const bare = (name: string, optional = false) => ({ var_name: name, scope: '', defined_in: [], ...(optional ? { optional: true as const } : {}) });
  const ROOT_BARE = [{ scope: '', env_files: [] }];

  async function openAlert(endpointId: string) {
    await recordCheck(db, endpointId, ok(minutes(-10)));
    await recordCheck(db, endpointId, fail(minutes(0)));
    return (await recordCheck(db, endpointId, fail(minutes(1)))).event;
  }

  it('names the variables the deploy newly references, since that scope has no MISSING rows', async () => {
    const { endpoint, project } = await setup();
    await recordScan(db, { projectId: project.id, sha: 'aaaaaaa', branch: 'main', deployedAt: minutes(-60), findings: [], variables: [bare('DATABASE_URL')], envScopes: ROOT_BARE });
    const linked = await recordScan(db, {
      projectId: project.id,
      sha: 'b52952e8192c38c054e53b5447ea20de88f2e2e9',
      branch: 'main',
      deployedAt: minutes(-4),
      findings: [],
      variables: [bare('DATABASE_URL'), bare('STRIPE_KEY'), bare('REDIS_URL'), bare('CACHE_TTL', true)],
      envScopes: ROOT_BARE,
    });
    const event = await openAlert(endpoint.id);
    expect(event?.message).toBe('api.acme.com started failing 4m after deploy b52952e, which introduced 2 new env vars no env file declares: REDIS_URL, STRIPE_KEY');
    expect((await db.select().from(alerts))[0]?.relatedDeployId).toBe(linked.deployId);
  });

  it('reads what an older previous scan referenced from its MISSING rows', async () => {
    const { endpoint, project } = await setup();
    // 0.1.0: no variable list, and every reference in a scope with no env file was a MISSING row.
    await recordScan(db, { projectId: project.id, sha: 'aaaaaaa', branch: 'main', deployedAt: minutes(-60), findings: [missing('DATABASE_URL')] });
    await recordScan(db, { projectId: project.id, sha: 'bbbbbbb', branch: 'main', deployedAt: minutes(-4), findings: [], variables: [bare('DATABASE_URL'), bare('REDIS_URL')], envScopes: ROOT_BARE });
    expect((await openAlert(endpoint.id))?.message).toBe('api.acme.com started failing 4m after deploy bbbbbbb, which introduced 1 new env var no env file declares: REDIS_URL');
  });

  it('names both kinds when a deploy adds a MISSING var in one scope and an undeclared one in another', async () => {
    const { endpoint, project } = await setup();
    const scopes = [{ scope: '', env_files: [] }, { scope: 'apps/web', env_files: ['.env.example' as const] }];
    await recordScan(db, { projectId: project.id, sha: 'aaaaaaa', branch: 'main', deployedAt: minutes(-60), findings: [], variables: [], envScopes: scopes });
    await recordScan(db, {
      projectId: project.id,
      sha: 'bbbbbbb',
      branch: 'main',
      deployedAt: minutes(-4),
      findings: [missing('WEB_SECRET')],
      variables: [{ var_name: 'WEB_SECRET', scope: 'apps/web', defined_in: [] }, bare('ROOT_TOKEN')],
      envScopes: scopes,
    });
    expect((await openAlert(endpoint.id))?.message).toBe(
      'api.acme.com started failing 4m after deploy bbbbbbb, which introduced 1 missing env var: WEB_SECRET, plus 1 new env var no env file declares: ROOT_TOKEN',
    );
  });

  it('correlates scans from CLIs before 0.2.0 (no env scopes) exactly as before', async () => {
    const { endpoint, project } = await setup();
    await recordScan(db, { projectId: project.id, sha: 'aaaaaaa', branch: 'main', deployedAt: minutes(-60), findings: [], variables: [] });
    // A variable list with nothing defined but no env scopes: nothing to call "undeclared".
    await recordScan(db, { projectId: project.id, sha: 'bbbbbbb', branch: 'main', deployedAt: minutes(-4), findings: [], variables: [bare('NEW_ONE')] });
    expect((await openAlert(endpoint.id))?.message).toBe('api.acme.com started failing 4m after deploy bbbbbbb, which had no new config findings');
  });
});

describe('rollupChecks', () => {
  it('writes one row per endpoint per complete UTC day, skips today, and is idempotent', async () => {
    const { endpoint, project } = await setup();
    const other = await makeEndpoint(db, project.id);
    const at = (iso: string) => new Date(iso);
    const rows = [
      { endpointId: endpoint.id, ...ok(at('2026-09-26T00:00:00Z')) },
      { endpointId: endpoint.id, ...fail(at('2026-09-26T23:59:59Z')) },
      { endpointId: endpoint.id, ...ok(at('2026-09-27T12:00:00Z')) },
      { endpointId: other.id, ...fail(at('2026-09-27T01:00:00Z')) },
      { endpointId: endpoint.id, ...ok(at('2026-09-28T00:00:01Z')) }, // today: not complete yet
    ];
    await db.insert(checks).values(rows);

    const today = at('2026-09-28T12:00:00Z');
    expect(await rollupChecks(db, today)).toBe(3);
    const stats = async () =>
      (await db.select().from(endpointDailyStats))
        .map((s) => [s.endpointId === endpoint.id ? 'main' : 'other', s.day, s.checks, s.ok] as const)
        .sort((a, b) => `${a[1]}${a[0]}`.localeCompare(`${b[1]}${b[0]}`));
    expect(await stats()).toEqual([
      ['main', '2026-09-26', 2, 1],
      ['main', '2026-09-27', 1, 1],
      ['other', '2026-09-27', 1, 0],
    ]);

    // Running again changes nothing; a check recorded late for a past day is picked up.
    expect(await rollupChecks(db, today)).toBe(3);
    await db.insert(checks).values({ endpointId: endpoint.id, ...fail(at('2026-09-27T23:59:00Z')) });
    await rollupChecks(db, today);
    expect((await stats()).find((s) => s[0] === 'main' && s[1] === '2026-09-27')).toEqual(['main', '2026-09-27', 2, 1]);
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

  it('also forgets host slots that passed before the cutoff', async () => {
    await db.insert(checkHosts).values([
      { hostname: 'old.example', nextSlotAt: minutes(-60 * 24 * 31) },
      { hostname: 'recent.example', nextSlotAt: minutes(-1) },
    ]);
    await pruneChecks(db, minutes(-60 * 24 * 30));
    expect((await db.select().from(checkHosts)).map((h) => h.hostname)).toEqual(['recent.example']);
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

describe('endpoint names', () => {
  const input = { url: 'https://api.acme.com/health', method: 'GET' as const, intervalSeconds: 60 as const, expectedStatus: 200, enabled: true };

  it('are saved on create, kept when an update omits them and cleared with null', async () => {
    const { user, project } = await setup();
    const created = await createEndpoint(db, user.id, project.id, { ...input, name: 'Acme API' });
    expect(created?.name).toBe('Acme API');
    expect((await updateEndpoint(db, user.id, created!.id, { ...input, intervalSeconds: 300 }))?.name).toBe('Acme API');
    expect((await updateEndpoint(db, user.id, created!.id, { ...input, name: null }))?.name).toBeNull();
  });

  it('replace the host in alert messages and open-alert views', async () => {
    const { user, project, endpoint } = await setup();
    await db.update(endpoints).set({ name: 'Acme API' }).where(eq(endpoints.id, endpoint.id));

    await recordCheck(db, endpoint.id, ok(minutes(0)));
    await recordCheck(db, endpoint.id, fail(minutes(1)));
    const opened = await recordCheck(db, endpoint.id, fail(minutes(2)));
    expect(opened.event?.message).toBe('Acme API started failing; no deploy in the 30 minutes before the first failure');
    expect(await listOpenAlerts(db, user.id, project.id)).toMatchObject([
      { endpointUrl: 'https://api.acme.com/health', endpointName: 'Acme API' },
    ]);
    expect((await recordCheck(db, endpoint.id, ok(minutes(23)))).event?.message).toBe('Acme API is back up (alert open for 21m)');
  });

  it('label the endpoints behind a project badge, longest-failing first, falling back to the host', async () => {
    const { user, project, endpoint } = await setup();
    await db.update(endpoints).set({ name: 'Acme API' }).where(eq(endpoints.id, endpoint.id));
    const cdn = await makeEndpoint(db, project.id, { url: 'https://cdn.acme.com/' });
    const healthy = await makeEndpoint(db, project.id, { name: 'Healthy' });
    for (const id of [endpoint.id, cdn.id]) await recordCheck(db, id, ok(minutes(-60)));
    await recordCheck(db, cdn.id, fail(minutes(-30)));
    await recordCheck(db, cdn.id, fail(minutes(-29)));
    await recordCheck(db, endpoint.id, fail(minutes(-10)));
    await recordCheck(db, endpoint.id, fail(minutes(-9)));
    await recordCheck(db, healthy.id, ok(minutes(-1)));

    const [row] = await listProjectsForOwner(db, user.id);
    expect(row).toMatchObject({ uptime: 'down', failingSince: minutes(-30), failingEndpoints: ['cdn.acme.com', 'Acme API'] });

    await recordCheck(db, cdn.id, ok(minutes(-1)));
    expect((await listProjectsForOwner(db, user.id))[0]?.failingEndpoints).toEqual(['Acme API']);
  });
});

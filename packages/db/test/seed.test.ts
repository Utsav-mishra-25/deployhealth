import { hashToken } from '@deployhealth/core';
import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listClientsOverview } from '../src/clients';
import { DEMO_GITHUB_ID } from '../src/demo';
import { getProjectMonitoring, listOpenAlerts } from '../src/monitoring';
import { findProjectByTokenHash, getLatestScan, listDeploys } from '../src/queries';
import { alerts, checks, clients, endpoints, projects, users } from '../src/schema';
import { DEMO_DEPLOY_COUNT, DEMO_PROJECT, demoDeploys, SCENARIO, seed } from '../src/seed';
import { makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;
const NOW = new Date('2026-09-28T12:00:00Z');
const FIRST_FAILURE = new Date(NOW.getTime() - (SCENARIO.deployMinutesAgo - SCENARIO.failureAfterDeployMinutes) * 60_000);

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

describe('seed', () => {
  it('creates two clients and three projects, one unassigned, each with endpoints', async () => {
    const result = await seed(db, NOW);
    const [user] = await db.select().from(users).where(eq(users.githubId, DEMO_GITHUB_ID));
    expect(user).toMatchObject({ id: result.userId, login: 'demo' });

    const overview = await listClientsOverview(db, result.userId);
    expect(overview.clients.map((c) => [c.name, c.projects.map((p) => p.name)])).toEqual([
      ['Acme Corp', ['acme-storefront']],
      ['Northwind Bakery', ['northwind-site']],
    ]);
    expect(overview.unassigned.map((p) => p.name)).toEqual(['portfolio']);

    const endpointRows = await db.select({ projectId: endpoints.projectId }).from(endpoints);
    expect(new Set(endpointRows.map((e) => e.projectId)).size).toBe(3);
  });

  it('keeps the storefront deploy story, ending in a deploy that adds two missing vars', async () => {
    const result = await seed(db, NOW);
    const deploys = await listDeploys(db, result.projectId);
    expect(deploys).toHaveLength(DEMO_DEPLOY_COUNT);
    expect(deploys.every((d) => d.scanCount === 1)).toBe(true);
    const [latest] = deploys;
    expect(latest?.deploy.sha.slice(0, 7)).toBe('b52952e');
    expect(latest?.counts).toEqual({ missing: 3, unused: 2, mismatch: 1 });
    const detail = await getLatestScan(db, result.projectId, latest!.deploy.id);
    expect(detail?.findings.filter((f) => f.kind === 'missing').map((f) => f.var_name)).toEqual([
      'ANALYTICS_WRITE_KEY',
      'REDIS_URL',
      'STRIPE_KEY',
    ]);
  });

  it('produces the scripted open alert through the real alert logic', async () => {
    const result = await seed(db, NOW);
    const [open] = await listOpenAlerts(db, result.userId, result.projectId);
    expect(open?.alert.message).toBe(
      'api.acme.example started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
    );
    expect(open?.deploy?.sha.slice(0, 7)).toBe('b52952e');
    expect(open?.endpointUrl).toBe('https://api.acme.example/health');
    expect(await db.select().from(alerts).where(isNull(alerts.resolvedAt))).toHaveLength(1);
  });

  it('includes a resolved past incident with no deploy nearby', async () => {
    await seed(db, NOW);
    const resolved = (await db.select().from(alerts)).filter((a) => a.resolvedAt);
    expect(resolved.map((a) => a.message)).toEqual([
      'example.org started failing; no deploy in the 30 minutes before the first failure',
    ]);
  });

  it('writes seven days of checks at realistic latency, and a consistent endpoint state', async () => {
    const result = await seed(db, NOW);
    const monitoring = await getProjectMonitoring(db, result.userId, result.projectId, NOW);
    const api = monitoring.find((m) => m.endpoint.url === 'https://api.acme.example/health')!;
    const homepage = monitoring.find((m) => m.endpoint.url === 'https://example.com/')!;

    expect(api.status).toBe('down');
    expect(api.failingSince).toEqual(FIRST_FAILURE);
    expect(api.endpoint.consecutiveFailures).toBeGreaterThanOrEqual(20);
    expect(api.recent[0]).toMatchObject({ ok: false, statusCode: 503 });
    expect(api.uptime7d).toBeGreaterThan(0.99);
    expect(api.latency.length).toBeGreaterThanOrEqual(23);
    expect(api.latency.every((b) => b.p50 >= 40 && b.p50 <= 200 && b.p95 >= b.p50)).toBe(true);

    expect(homepage.status).toBe('up');
    expect(homepage.failingSince).toBeNull();
    expect(homepage.uptime24h).toBeGreaterThan(0.95);

    const [oldest] = await db.select({ at: checks.checkedAt }).from(checks).orderBy(checks.checkedAt).limit(1);
    expect(NOW.getTime() - oldest!.at.getTime()).toBeGreaterThan(6.9 * 86_400_000);
    expect(api.endpoint.nextCheckAt.getTime()).toBeGreaterThan(NOW.getTime() - 60_000);
  });

  it('shows up/down badges on the clients page', async () => {
    const result = await seed(db, NOW);
    const overview = await listClientsOverview(db, result.userId);
    const all = [...overview.clients.flatMap((c) => c.projects), ...overview.unassigned];
    expect(Object.fromEntries(all.map((p) => [p.name, p.uptime]))).toEqual({
      'acme-storefront': 'down',
      'northwind-site': 'up',
      portfolio: 'up',
    });
    expect(all.find((p) => p.name === 'acme-storefront')?.failingSince).toEqual(FIRST_FAILURE);
  });

  it('prints a token that authenticates the storefront project', async () => {
    const result = await seed(db, NOW);
    expect(await findProjectByTokenHash(db, hashToken(result.token))).toMatchObject({ id: result.projectId, name: DEMO_PROJECT.name });
  });

  it('is idempotent and leaves other users alone', async () => {
    const other = await makeUser(db);
    await seed(db, NOW);
    const second = await seed(db, NOW);

    expect(await db.select().from(users)).toHaveLength(2);
    expect(await db.select().from(clients)).toHaveLength(2);
    expect(await db.select().from(projects)).toHaveLength(3);
    expect(await db.select().from(alerts)).toHaveLength(2);
    expect(await listDeploys(db, second.projectId)).toHaveLength(DEMO_DEPLOY_COUNT);
    expect((await db.select().from(users).where(eq(users.id, other.id)))[0]).toBeTruthy();
  });

  it('builds deterministic, unique shas in chronological order', () => {
    const deploys = demoDeploys(NOW);
    expect(new Set(deploys.map((d) => d.sha)).size).toBe(DEMO_DEPLOY_COUNT);
    expect(deploys.map((d) => d.sha)).toEqual(demoDeploys(NOW).map((d) => d.sha));
    const times = deploys.map((d) => d.deployedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

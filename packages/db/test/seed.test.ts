import { githubActionSnippet, hashToken, parseHandoffVariables, renderHandoffMarkdown } from '@deployhealth/core';
import { eq, isNull } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { listClientsOverview } from '../src/clients';
import { agentPrStats, listPrChecksForOwner } from '../src/github';
import { getHandoffData } from '../src/handoff';
import { DEMO_ENDPOINT_IDS, DEMO_GITHUB_ID, DEMO_PROJECT_IDS } from '../src/demo';
import { getProjectMonitoring, listOpenAlerts } from '../src/monitoring';
import { findProjectByTokenHash, getLatestScan, getProjectForOwner, listDeploys } from '../src/queries';
import { alerts, checks, clients, endpoints, installations, prChecks, projects, users } from '../src/schema';
import { DEMO_DEPLOY_COUNT, DEMO_FRESHNESS, DEMO_PROJECT, demoBrokenUrl, demoDeploys, SCENARIO, seed } from '../src/seed';
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

  it('produces the scripted open alert through the real alert logic, naming the endpoint', async () => {
    const result = await seed(db, NOW);
    const [open] = await listOpenAlerts(db, result.userId, result.projectId);
    expect(open?.alert.message).toBe(
      'Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
    );
    expect(open?.deploy?.sha.slice(0, 7)).toBe('b52952e');
    expect(open).toMatchObject({ endpointName: 'Acme API', endpointUrl: 'http://localhost:3000/api/demo/broken' });
    expect(await db.select().from(alerts).where(isNull(alerts.resolvedAt))).toHaveLength(1);
  });

  it('points the failing endpoint at DEMO_BASE_URL and names the demo endpoints', async () => {
    await seed(db, NOW, { baseUrl: 'https://web-production-1234.up.railway.app/' });
    const rows = await db.select({ name: endpoints.name, url: endpoints.url }).from(endpoints).orderBy(endpoints.url);
    expect(rows).toEqual([
      { name: 'Acme storefront', url: 'https://example.com/' },
      { name: null, url: 'https://example.net/' },
      { name: 'Northwind site', url: 'https://example.org/' },
      { name: 'Acme API', url: 'https://web-production-1234.up.railway.app/api/demo/broken' },
    ]);
    expect(demoBrokenUrl('http://localhost:3000')).toBe('http://localhost:3000/api/demo/broken');
    expect(() => demoBrokenUrl('ftp://example.com')).toThrow(/http/);
  });

  it('includes a resolved past incident with no deploy nearby', async () => {
    await seed(db, NOW);
    const resolved = (await db.select().from(alerts)).filter((a) => a.resolvedAt);
    expect(resolved.map((a) => a.message)).toEqual([
      'Northwind site started failing; no deploy in the 30 minutes before the first failure',
    ]);
  });

  it('writes seven days of checks at realistic latency, and a consistent endpoint state', async () => {
    const result = await seed(db, NOW);
    const monitoring = await getProjectMonitoring(db, result.userId, result.projectId, NOW);
    const api = monitoring.find((m) => m.endpoint.name === SCENARIO.endpointName)!;
    const homepage = monitoring.find((m) => m.endpoint.url === 'https://example.com/')!;

    expect(api.status).toBe('down');
    expect(api.failingSince).toEqual(FIRST_FAILURE);
    expect(api.endpoint.consecutiveFailures).toBe(SCENARIO.deployMinutesAgo - SCENARIO.failureAfterDeployMinutes);
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

  it('is idempotent, keeps project ids and alert text stable, and leaves other users alone', async () => {
    const other = await makeUser(db);
    const first = await seed(db, NOW);
    const firstMessages = (await db.select({ message: alerts.message }).from(alerts)).map((a) => a.message).sort();
    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await seed(db, later);

    expect(await db.select().from(users)).toHaveLength(2);
    // The demo user row survives reseeds: ids a request read before a reseed stay valid after it.
    expect(second.userId).toBe(first.userId);
    expect((await db.select({ id: endpoints.id }).from(endpoints)).map((e) => e.id).sort()).toEqual(Object.values(DEMO_ENDPOINT_IDS).sort());
    expect(await db.select().from(clients)).toHaveLength(2);
    expect((await db.select({ id: projects.id }).from(projects)).map((p) => p.id).sort()).toEqual(Object.values(DEMO_PROJECT_IDS).sort());
    expect(second.projectId).toBe(first.projectId);
    expect(second.projectId).toBe(DEMO_PROJECT_IDS.storefront);
    expect((await db.select({ message: alerts.message }).from(alerts)).map((a) => a.message).sort()).toEqual(firstMessages);
    expect(await db.select().from(endpoints)).toHaveLength(4);
    expect(await db.$count(installations)).toBe(1);
    expect(await db.$count(prChecks)).toBe(4);
    expect(await listDeploys(db, second.projectId)).toHaveLength(DEMO_DEPLOY_COUNT);
    expect((await db.select().from(users).where(eq(users.id, other.id)))[0]).toBeTruthy();
  });

  it('shows checked pull requests: agents adding undeclared vars, on the project and the client', async () => {
    const { userId } = await seed(db, NOW);
    const storefront = await listPrChecksForOwner(db, userId, DEMO_PROJECT_IDS.storefront);
    expect(storefront.map((c) => [c.prNumber, c.authorLogin, c.agentName, c.conclusion, c.undeclared, c.closed])).toEqual([
      [87, 'claude[bot]', 'Claude', 'neutral', 1, false],
      [86, 'Copilot', 'Copilot', 'success', 0, true],
      [85, 'maya-lopez', null, 'success', 0, true],
    ]);
    const [acme] = (await listClientsOverview(db, userId)).clients.filter((c) => c.name === 'Acme Corp');
    expect(acme!.projects[0]!.openPrsWithUndeclared).toBe(1);
    const september = [new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z')] as const;
    expect(await agentPrStats(db, userId, acme!.id, ...september)).toEqual({ undeclared: 1, total: 2 });
  });

  it('keeps the incident fresh: the deploy is inside the freshness window and Acme API has been down under an hour', async () => {
    const result = await seed(db, NOW);
    const [latest] = await listDeploys(db, result.projectId);
    const deployAgeMinutes = (NOW.getTime() - latest!.deploy.deployedAt.getTime()) / 60_000;
    expect(deployAgeMinutes).toBeGreaterThanOrEqual(DEMO_FRESHNESS.minDeployAgeMinutes);
    expect(deployAgeMinutes).toBeLessThanOrEqual(DEMO_FRESHNESS.maxDeployAgeMinutes);
    const api = (await getProjectMonitoring(db, result.userId, result.projectId, NOW)).find((m) => m.endpoint.name === SCENARIO.endpointName)!;
    expect((NOW.getTime() - api.failingSince!.getTime()) / 60_000).toBeLessThan(DEMO_FRESHNESS.maxDownMinutes);
  });

  it('never leaves a request that started before a reseed with an empty or missing demo', async () => {
    const first = await seed(db, NOW);
    // What a /demo request resolved before the reseed committed…
    const ownerId = first.userId;
    await seed(db, new Date(NOW.getTime() + 30 * 60_000));
    // …still finds the demo's clients and projects after it.
    const overview = await listClientsOverview(db, ownerId);
    expect(overview.clients.map((c) => c.name)).toEqual(['Acme Corp', 'Northwind Bakery']);
    expect(await getProjectForOwner(db, DEMO_PROJECT_IDS.storefront, ownerId)).toMatchObject({ name: DEMO_PROJECT.name });
    expect(await getProjectMonitoring(db, ownerId, DEMO_PROJECT_IDS.storefront)).toHaveLength(2);
  });

  it('rolls back completely when it fails part-way', async () => {
    await seed(db, NOW);
    const before = (await db.select({ id: projects.id, name: projects.name }).from(projects)).length;
    await expect(seed(db, NOW, { baseUrl: 'not a url' })).rejects.toThrow();
    await expect(
      db.transaction(async (tx) => {
        await seed(tx, NOW);
        throw new Error('abort after seeding');
      }),
    ).rejects.toThrow('abort after seeding');
    expect(await db.select().from(projects)).toHaveLength(before);
    expect(await db.select().from(alerts)).toHaveLength(2);
  });

  it('gives every demo deploy a variable list that agrees with its MISSING findings', () => {
    // The demo repo's scopes are apps/<name>; a MISSING finding belongs to its file's scope.
    const scopeOf = (file: string | null) => /^apps\/[^/]+/.exec(file ?? '')?.[0] ?? '';
    for (const d of demoDeploys(NOW)) {
      const undefinedVars = d.variables.filter((v) => v.defined_in.length === 0).map((v) => `${v.scope}:${v.var_name}`).sort();
      const missing = [...new Set(d.findings.filter((f) => f.kind === 'missing').map((f) => `${scopeOf(f.file)}:${f.var_name}`))].sort();
      expect(undefinedVars, d.sha).toEqual(missing);
    }
  });

  it('makes a complete demo handoff: variables by scope, the two new missing ones, deploy notes', async () => {
    const result = await seed(db, NOW);
    const data = await getHandoffData(db, result.userId, DEMO_PROJECT_IDS.storefront, NOW);
    const markdown = renderHandoffMarkdown({ ...data!, actionSnippet: githubActionSnippet({ appUrl: 'https://demo.example' }) });
    const variables = parseHandoffVariables(markdown);
    expect(new Set(variables.map((v) => v.scope))).toEqual(new Set(['apps/api', 'apps/web', 'apps/worker']));
    expect(variables.filter((v) => v.defined_in.length === 0).map((v) => `${v.scope}:${v.var_name}`)).toEqual([
      'apps/api:REDIS_URL',
      'apps/api:STRIPE_KEY',
      'apps/web:ANALYTICS_WRITE_KEY',
    ]);
    expect(data?.scan?.variablesReported).toBe(true);
    expect(data?.deployNotes).toContain('## Deploying');
    expect(data?.alerts.map((a) => a.message)).toContain(
      'Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY',
    );
    expect((await getHandoffData(db, result.userId, DEMO_PROJECT_IDS.portfolio, NOW))?.deployNotes).toBeNull();
  });

  it('builds deterministic, unique shas in chronological order', () => {
    const deploys = demoDeploys(NOW);
    expect(new Set(deploys.map((d) => d.sha)).size).toBe(DEMO_DEPLOY_COUNT);
    expect(deploys.map((d) => d.sha)).toEqual(demoDeploys(NOW).map((d) => d.sha));
    const times = deploys.map((d) => d.deployedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

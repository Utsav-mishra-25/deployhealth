import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { githubActionSnippet, parseEnv, parseHandoffVariables, renderHandoffMarkdown, scanProject } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getHandoffData } from '../src/handoff';
import { recordCheck, uptimeBetween, type CheckOutcome } from '../src/monitoring';
import { recordScan } from '../src/queries';
import { alerts, checks, endpointDailyStats, endpoints, projects } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;
const NOW = new Date('2026-09-28T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const ok = (at: Date): CheckOutcome => ({ checkedAt: at, statusCode: 200, latencyMs: 90, ok: true, error: null });
const fail = (at: Date): CheckOutcome => ({ checkedAt: at, statusCode: 503, latencyMs: 30, ok: false, error: 'Expected 200, got 503' });

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

/**
 * A repo with env files full of realistic-looking secrets. Every value is distinctive, so finding
 * any of them in the handoff would be a leak, not a coincidence. They're all fake; the ones shaped
 * like real key formats are assembled at run time, so secret scanners don't flag this file.
 */
// Built indirectly so deployhealth's own scanner (`pnpm scan:self`) doesn't read these as references.
const ENV = ['process', 'env'].join('.');
const fake = (...parts: string[]) => parts.join('');

const FIXTURE: Record<string, string> = {
  '.env': [
    'DATABASE_URL=postgres://admin:Sup3r-S3cret-pw@db.prod.acme.io:5432/acme_production',
    `STRIPE_KEY=${fake('sk_', 'live_', '51HxAbCdEfGhIjKlMnOpQrStUvWxYz0123456789')}`,
    `API_TOKEN="${fake('gh', 'p_', 'R3alLook1ngT0kenAbcdefghijklmnopqrstu')}"`,
    `SESSION_SECRET='${fake('f3a9c1d7', 'e2b84a6f', '9c0d1e2f', '3a4b5c6d')}'`,
    `UNUSED_WEBHOOK=${fake('https://hooks.', 'slack.com/services/', 'T0A1B2C3D/B0E1F2G3H/abcdefghijklmnopqrstuvwx')}`,
  ].join('\n'),
  '.env.example': [
    'DATABASE_URL=postgres://example-user:example-password@localhost:5432/acme_dev',
    'STRIPE_KEY=sk_test_placeholder_do_not_use_000000',
    'SENTRY_DSN=https://abc123def456abc123@o123456.ingest.sentry.io/7890123',
  ].join('\n'),
  'apps/api/.env.local': 'REDIS_URL=redis://:r3dis-pa55word-local@redis.internal:6379/0\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  'apps/api/src/cache.ts': `export const url = ${ENV}.REDIS_URL;\nexport const other = ${ENV}.MISSING_ONE;\n`,
  'src/server.ts': [
    `const db = ${ENV}.DATABASE_URL;`,
    `const stripe = ${ENV}.STRIPE_KEY;`,
    `const gh = ${ENV}.API_TOKEN;`,
    `const sentry = ${ENV}.SENTRY_DSN;`,
    `const session = ${ENV}.SESSION_SECRET;`,
  ].join('\n'),
};

async function writeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dh-handoff-'));
  for (const [file, content] of Object.entries(FIXTURE)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

describe('getHandoffData', () => {
  it('never includes a value from any env file, from the real scanner to the Markdown', async () => {
    const root = await writeFixture();
    try {
      const user = await makeUser(db);
      const project = await makeProject(db, user.id, 'acme-api');
      await db
        .update(projects)
        .set({ deployNotes: '## Deploy\n\nPush to `main`; Railway builds it.' })
        .where(eq(projects.id, project.id));

      const scan = await scanProject(root);
      await recordScan(db, { projectId: project.id, sha: 'abc1234', branch: 'main', deployedAt: minutesAgo(30), findings: scan.findings, variables: scan.variables });

      const source = await getHandoffData(db, user.id, project.id, NOW);
      expect(source).not.toBeNull();
      const markdown = renderHandoffMarkdown({ ...source!, actionSnippet: githubActionSnippet({ appUrl: 'https://deployhealth.example' }) });

      // Every value in every env file of the fixture, read with the same parser the scanner uses.
      const values = [];
      for (const file of Object.keys(FIXTURE).filter((f) => f.split('/').pop()!.startsWith('.env'))) {
        const { entries } = parseEnv(await readFile(join(root, file), 'utf8'));
        values.push(...entries.map((e) => e.value).filter((value) => value.length > 0));
      }
      expect(values.length).toBeGreaterThanOrEqual(10);

      const everything = `${JSON.stringify(source)}\n${markdown}`;
      for (const value of values) expect(everything, `leaked ${value}`).not.toContain(value);
      // Pieces of values too: hosts, passwords and key prefixes.
      for (const fragment of ['Sup3r-S3cret', 'db.prod.acme.io', 'sk_live_', 'ghp_R3al', 'r3dis-pa55word', 'hooks.slack.com/services', 'wJalrXUtnFEMI']) {
        expect(everything, `leaked ${fragment}`).not.toContain(fragment);
      }

      // Names are all there, flagged correctly.
      expect(parseHandoffVariables(markdown)).toEqual([
        { var_name: 'API_TOKEN', scope: '', defined_in: ['.env'] },
        { var_name: 'DATABASE_URL', scope: '', defined_in: ['.env.example', '.env'] },
        { var_name: 'SENTRY_DSN', scope: '', defined_in: ['.env.example'] },
        { var_name: 'SESSION_SECRET', scope: '', defined_in: ['.env'] },
        { var_name: 'STRIPE_KEY', scope: '', defined_in: ['.env.example', '.env'] },
        { var_name: 'MISSING_ONE', scope: 'apps/api', defined_in: [] },
        { var_name: 'REDIS_URL', scope: 'apps/api', defined_in: ['.env.local'] },
      ]);
      expect(markdown).toContain('| `MISSING_ONE` | — | **missing** |');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is owner-scoped', async () => {
    const owner = await makeUser(db);
    const project = await makeProject(db, owner.id);
    expect(await getHandoffData(db, (await makeUser(db)).id, project.id, NOW)).toBeNull();
    expect(await getHandoffData(db, owner.id, project.id, NOW)).toMatchObject({ scan: null, variables: [], findings: [], client: null });
  });

  it('covers 30 days of uptime and alerts, names endpoints and includes the client', async () => {
    const user = await makeUser(db);
    const client = await makeClient(db, user.id, 'Acme Corp');
    const project = await makeProject(db, user.id, 'shop');
    await db.update(projects).set({ clientId: client.id }).where(eq(projects.id, project.id));
    const api = await makeEndpoint(db, project.id, { url: 'https://api.acme.com/health', name: 'Acme API' });
    const quiet = await makeEndpoint(db, project.id, { url: 'https://acme.com/' });

    await recordCheck(db, api.id, ok(daysAgo(40)));
    // An incident 35 days ago: outside the window.
    await recordCheck(db, api.id, fail(daysAgo(35)));
    await recordCheck(db, api.id, fail(new Date(daysAgo(35).getTime() + 60_000)));
    await recordCheck(db, api.id, ok(new Date(daysAgo(35).getTime() + 120_000)));
    // Recent: 3 ok, then a failing run that opens an alert and stays open.
    for (const m of [300, 200, 100]) await recordCheck(db, api.id, ok(minutesAgo(m)));
    await recordCheck(db, api.id, fail(minutesAgo(2)));
    await recordCheck(db, api.id, fail(minutesAgo(1)));

    const data = await getHandoffData(db, user.id, project.id, NOW);
    expect(data?.client).toEqual({ name: 'Acme Corp', contactEmail: null });
    expect(data?.window).toEqual({ from: new Date('2026-08-30T00:00:00Z'), to: NOW });
    expect(data?.endpoints.map((e) => [e.label, e.uptime])).toEqual([
      ['Acme API', 3 / 5],
      ['acme.com', null],
    ]);
    expect(data?.uptime).toBe(3 / 5);
    expect(data?.alerts).toEqual([
      expect.objectContaining({ endpoint: 'Acme API', openedAt: minutesAgo(1), resolvedAt: null, message: expect.stringContaining('Acme API started failing') }),
    ]);
    expect(quiet).toBeTruthy();
  });

  it('includes an alert that opened before the window but is still open', async () => {
    const user = await makeUser(db);
    const project = await makeProject(db, user.id);
    const endpoint = await makeEndpoint(db, project.id);
    await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'down for ages', createdAt: daysAgo(45) });
    await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'old and over', createdAt: daysAgo(50), resolvedAt: daysAgo(49) });
    expect((await getHandoffData(db, user.id, project.id, NOW))?.alerts.map((a) => a.message)).toEqual(['down for ages']);
  });
});

describe('uptimeBetween', () => {
  it('counts rolled-up days from endpoint_daily_stats and every other day from raw checks', async () => {
    const project = await makeProject(db, (await makeUser(db)).id);
    const endpoint = await makeEndpoint(db, project.id);
    // Sept 1 was rolled up and its raw checks pruned; Sept 2 is rolled up AND still has raw
    // checks (the rollup wins); Sept 3 only has raw checks.
    await db.insert(endpointDailyStats).values([
      { endpointId: endpoint.id, day: '2026-09-01', checks: 1440, ok: 1430 },
      { endpointId: endpoint.id, day: '2026-09-02', checks: 1440, ok: 1440 },
    ]);
    await db.insert(checks).values([
      { endpointId: endpoint.id, ...fail(new Date('2026-09-02T10:00:00Z')) },
      { endpointId: endpoint.id, ...ok(new Date('2026-09-03T10:00:00Z')) },
      { endpointId: endpoint.id, ...fail(new Date('2026-09-03T11:00:00Z')) },
      { endpointId: endpoint.id, ...ok(new Date('2026-10-01T00:00:00Z')) }, // outside the range
    ]);
    const september = await uptimeBetween(db, endpoint.id, new Date('2026-09-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
    expect(september).toEqual({ checks: 1440 + 1440 + 2, ok: 1430 + 1440 + 1 });

    // A range starting mid-day ignores that day's rollup and uses whatever raw checks remain.
    const fromNoon = await uptimeBetween(db, endpoint.id, new Date('2026-09-02T09:00:00Z'), new Date('2026-09-04T00:00:00Z'));
    expect(fromNoon).toEqual({ checks: 3, ok: 1 });
    expect(await uptimeBetween(db, endpoint.id, new Date('2026-08-01T00:00:00Z'), new Date('2026-08-31T00:00:00Z'))).toEqual({ checks: 0, ok: 0 });
  });
});

describe('handoff storage', () => {
  it('keeps endpoints named in the alert history even after renames (the stored message is unchanged)', async () => {
    const user = await makeUser(db);
    const project = await makeProject(db, user.id);
    const endpoint = await makeEndpoint(db, project.id, { name: 'Old name' });
    await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'Old name started failing', createdAt: minutesAgo(10) });
    await db.update(endpoints).set({ name: 'New name' }).where(eq(endpoints.id, endpoint.id));
    expect((await getHandoffData(db, user.id, project.id, NOW))?.alerts).toEqual([
      expect.objectContaining({ endpoint: 'New name', message: 'Old name started failing' }),
    ]);
  });
});

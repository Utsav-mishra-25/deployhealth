import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EXPORT_FORMAT, exportUserData } from '../src/export';
import { setPrCheckGithubIds, upsertInstallation, upsertPrCheck } from '../src/github';
import { recordScan } from '../src/queries';
import { alerts, checks, endpointDailyStats, projects } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const WEBHOOK = 'https://hooks.slack.com/services/T0/B0/webhookSecretPart';

async function aliceWithEverything() {
  const user = await makeUser(db, 'alice');
  const client = await makeClient(db, user.id, 'Acme');
  const project = await makeProject(db, user.id, 'acme-app');
  await db.update(projects).set({ clientId: client.id, alertWebhookUrl: WEBHOOK, deployNotes: 'Push to main.' }).where(eq(projects.id, project.id));
  const { deployId } = await recordScan(db, {
    projectId: project.id,
    sha: 'abcdef1234567',
    branch: 'main',
    deployedAt: new Date('2026-10-01T10:00:00Z'),
    findings: [{ kind: 'missing', var_name: 'REDIS_URL', file: 'src/cache.ts', line: 12, env_file: null }],
    variables: [{ var_name: 'REDIS_URL', scope: '', defined_in: [] }],
  });
  const endpoint = await makeEndpoint(db, project.id, { url: 'https://api.acme.example/health?key=abc', name: 'Acme API' });
  await db.insert(checks).values({ endpointId: endpoint.id, ok: false, statusCode: 503, latencyMs: 10, error: 'Expected 200, got 503' });
  await db.insert(endpointDailyStats).values({ endpointId: endpoint.id, day: '2026-10-01', checks: 1440, ok: 1438 });
  await db.insert(alerts).values({ projectId: project.id, endpointId: endpoint.id, kind: 'endpoint_down', message: 'Acme API started failing', relatedDeployId: deployId });
  const installation = await upsertInstallation(db, { githubInstallationId: 7, accountLogin: 'acme-org', accountType: 'Organization', installerGithubId: user.githubId, repositorySelection: 'selected' }, ['acme-org/acme-app']);
  const pr = await upsertPrCheck(db, {
    projectId: project.id,
    installationId: installation.id,
    prNumber: 87,
    headSha: 'h1',
    baseSha: 'b1',
    authorLogin: 'claude[bot]',
    authorIsAgent: true,
    agentName: 'Claude',
    undeclaredVars: ['STRIPE_KEY'],
    committedEnvFiles: [{ path: 'apps/web/.env.local', added: true }],
    secretHits: 1,
    conclusion: 'failure',
  });
  await setPrCheckGithubIds(db, pr.id, { commentId: 555001, checkRunId: 555002 });
  return { user, client, project, deployId, endpoint };
}

describe('exportUserData', () => {
  it('exports every kind of data the user owns', async () => {
    const { user, client, project, deployId, endpoint } = await aliceWithEverything();
    const data = await exportUserData(db, user.id, new Date('2026-10-16T12:00:00Z'));
    expect(data).not.toBeNull();
    expect(data!.format).toBe(EXPORT_FORMAT);
    expect(data!.exportedAt).toBe('2026-10-16T12:00:00.000Z');
    expect(data!.account).toMatchObject({ login: 'alice', githubId: user.githubId });
    expect(data!.clients).toEqual([expect.objectContaining({ id: client.id, name: 'Acme' })]);
    expect(data!.projects).toEqual([
      expect.objectContaining({ id: project.id, name: 'acme-app', clientId: client.id, alertWebhook: 'set', deployNotes: 'Push to main.', pullRequestCheckMode: 'comment' }),
    ]);
    expect(data!.deploys).toEqual([expect.objectContaining({ id: deployId, sha: 'abcdef1234567', branch: 'main', deployedAt: '2026-10-01T10:00:00.000Z' })]);
    expect(data!.scans).toHaveLength(1);
    expect(data!.scans[0]!.findings).toEqual([{ kind: 'missing', variable: 'REDIS_URL', file: 'src/cache.ts', line: 12, envFile: null }]);
    expect(data!.scans[0]!.variables).toEqual([{ scope: '', variable: 'REDIS_URL', definedIn: [], optional: false }]);
    // The full URL, as entered (it's the user's own), and daily totals; raw checks are left out.
    expect(data!.endpoints).toEqual([
      expect.objectContaining({ id: endpoint.id, name: 'Acme API', url: 'https://api.acme.example/health?key=abc', dailyTotals: [{ day: '2026-10-01', checks: 1440, ok: 1438 }] }),
    ]);
    expect(data!.alerts).toEqual([expect.objectContaining({ message: 'Acme API started failing', deployId, resolvedAt: null })]);
    expect(data!.pullRequestChecks).toEqual([
      expect.objectContaining({
        number: 87,
        agent: 'Claude',
        undeclaredVariables: ['STRIPE_KEY'],
        committedEnvFiles: [{ path: 'apps/web/.env.local', added: true }],
        secretShapedStrings: 1,
        conclusion: 'failure',
      }),
    ]);
    expect(data!.githubAppInstallations).toEqual([
      expect.objectContaining({ account: 'acme-org', accountType: 'Organization', repositorySelection: 'selected', repositories: ['acme-org/acme-app'] }),
    ]);
  });

  it('never contains a token, its hash or hint, a webhook URL, raw checks or GitHub comment ids', async () => {
    const { user, project } = await aliceWithEverything();
    const [row] = await db.select().from(projects).where(eq(projects.id, project.id));
    const json = JSON.stringify(await exportUserData(db, user.id));
    for (const secret of [row!.apiTokenHash, row!.apiTokenHint, WEBHOOK, 'webhookSecretPart', 'Expected 200, got 503', '555001', '555002']) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toMatch(/token/i);
  });

  it('is null for an unknown user and empty lists for a new one', async () => {
    expect(await exportUserData(db, '00000000-0000-4000-8000-000000000000')).toBeNull();
    const user = await makeUser(db, 'new');
    expect(await exportUserData(db, user.id)).toMatchObject({ clients: [], projects: [], deploys: [], scans: [], endpoints: [], alerts: [], pullRequestChecks: [], githubAppInstallations: [] });
  });

});

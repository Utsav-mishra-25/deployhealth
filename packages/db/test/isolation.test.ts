import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignProjectToClient,
  deleteClient,
  getClientBySlug,
  getClientForOwner,
  listClients,
  listClientsOverview,
  updateClient,
  updateProjectSettings,
} from '../src/clients';
import {
  createEndpoint,
  deleteEndpoint,
  getProjectMonitoring,
  listEndpointsForOwner,
  listOpenAlerts,
  updateEndpoint,
} from '../src/monitoring';
import {
  ClientNotFoundError,
  createProject,
  getLatestScan,
  getProjectForOwner,
  listDeploys,
  listProjectsForOwner,
  recordScan,
  rotateProjectToken,
} from '../src/queries';
import { alerts, clients, endpoints, projects } from '../src/schema';
import { makeClient, makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

const endpointInput = { url: 'https://evil.example/', method: 'GET' as const, intervalSeconds: 60 as const, expectedStatus: 200, enabled: true };

/** User A (the attacker) and user B (the victim), each with a client, a project and an endpoint. */
async function twoUsers() {
  const a = await makeUser(db, 'alice');
  const b = await makeUser(db, 'bob');
  const aClient = await makeClient(db, a.id, 'Alice Co');
  const bClient = await makeClient(db, b.id, 'Bob Co');
  const aProject = await makeProject(db, a.id, 'alice-app');
  const bProject = await makeProject(db, b.id, 'bob-app');
  await db.update(projects).set({ clientId: bClient.id }).where(eq(projects.id, bProject.id));
  const bEndpoint = await makeEndpoint(db, bProject.id, { url: 'https://bob.example/health' });
  const bDeploy = await recordScan(db, { projectId: bProject.id, sha: 'abcdef1', branch: 'main', deployedAt: new Date(), findings: [] });
  await db.insert(alerts).values({ projectId: bProject.id, endpointId: bEndpoint.id, kind: 'endpoint_down', message: 'down' });
  return { a, b, aClient, bClient, aProject, bProject, bEndpoint, bDeploy };
}

describe("user A cannot read user B's data", () => {
  it('clients', async () => {
    const { a, bClient } = await twoUsers();
    expect(await getClientForOwner(db, a.id, bClient.id)).toBeNull();
    expect(await getClientBySlug(db, a.id, bClient.slug)).toBeNull();
    expect((await listClients(db, a.id)).map((c) => c.name)).toEqual(['Alice Co']);
    const overview = await listClientsOverview(db, a.id);
    expect(overview.clients.map((c) => c.name)).toEqual(['Alice Co']);
    expect(overview.unassigned.map((p) => p.name)).toEqual(['alice-app']);
  });

  it('projects, deploys and scans', async () => {
    const { a, bProject, bDeploy } = await twoUsers();
    expect(await getProjectForOwner(db, bProject.id, a.id)).toBeNull();
    expect((await listProjectsForOwner(db, a.id)).map((p) => p.name)).toEqual(['alice-app']);
    // Deploy and scan reads are only reachable through getProjectForOwner, but still scope by project.
    expect(await getLatestScan(db, (await makeProject(db, a.id)).id, bDeploy.deployId)).toBeNull();
    expect(await listDeploys(db, (await makeProject(db, a.id)).id)).toEqual([]);
  });

  it('endpoints, checks and alerts', async () => {
    const { a, bProject } = await twoUsers();
    expect(await listEndpointsForOwner(db, a.id, bProject.id)).toEqual([]);
    expect(await getProjectMonitoring(db, a.id, bProject.id)).toEqual([]);
    expect(await listOpenAlerts(db, a.id, bProject.id)).toEqual([]);
  });
});

describe("user A cannot modify user B's data", () => {
  it('clients', async () => {
    const { a, bClient } = await twoUsers();
    expect(await updateClient(db, a.id, bClient.id, { name: 'pwned' })).toBeNull();
    expect(await deleteClient(db, a.id, bClient.id)).toBe(false);
    const [still] = await db.select().from(clients).where(eq(clients.id, bClient.id));
    expect(still?.name).toBe('Bob Co');
  });

  it('projects: settings, token, client assignment in either direction', async () => {
    const { a, aClient, bClient, aProject, bProject } = await twoUsers();
    expect(await rotateProjectToken(db, bProject.id, a.id, { apiTokenHash: 'x', apiTokenHint: 'x' })).toBe(false);
    expect(await updateProjectSettings(db, a.id, bProject.id, { clientId: aClient.id, alertWebhookUrl: 'https://evil.example' })).toBe(false);
    // Attach B's project to A's client, or A's project to B's client.
    expect(await assignProjectToClient(db, a.id, bProject.id, aClient.id)).toBe(false);
    expect(await assignProjectToClient(db, a.id, aProject.id, bClient.id)).toBe(false);
    expect(await updateProjectSettings(db, a.id, aProject.id, { clientId: bClient.id, alertWebhookUrl: null })).toBe(false);
    await expect(
      createProject(db, { ownerId: a.id, name: 'x', repoFullName: 'a/x', apiTokenHash: 'h', apiTokenHint: 'h', clientId: bClient.id }),
    ).rejects.toBeInstanceOf(ClientNotFoundError);

    const [bAfter] = await db.select().from(projects).where(eq(projects.id, bProject.id));
    expect(bAfter).toMatchObject({ clientId: bClient.id, alertWebhookUrl: null, apiTokenHash: bProject.apiTokenHash });
    const [aAfter] = await db.select().from(projects).where(eq(projects.id, aProject.id));
    expect(aAfter?.clientId).toBeNull();
  });

  it('endpoints', async () => {
    const { a, bProject, bEndpoint } = await twoUsers();
    expect(await createEndpoint(db, a.id, bProject.id, endpointInput)).toBeNull();
    expect(await updateEndpoint(db, a.id, bEndpoint.id, endpointInput)).toBeNull();
    expect(await deleteEndpoint(db, a.id, bEndpoint.id)).toBe(false);
    const rows = await db.select().from(endpoints).where(eq(endpoints.projectId, bProject.id));
    expect(rows.map((e) => e.url)).toEqual(['https://bob.example/health']);
  });

  it('while the owner can do all of it', async () => {
    const { b, bClient, bProject, bEndpoint } = await twoUsers();
    expect(await updateEndpoint(db, b.id, bEndpoint.id, { ...endpointInput, url: 'https://bob.example/v2' })).toMatchObject({
      url: 'https://bob.example/v2',
    });
    expect(await updateProjectSettings(db, b.id, bProject.id, { clientId: null, alertWebhookUrl: 'https://hooks.example/x' })).toBe(true);
    expect(await deleteEndpoint(db, b.id, bEndpoint.id)).toBe(true);
    expect(await deleteClient(db, b.id, bClient.id)).toBe(true);
  });
});

import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assignProjectToClient,
  createClient,
  deleteClient,
  getClientBySlug,
  listClientsOverview,
  slugify,
  updateClient,
  updateProjectSettings,
} from '../src/clients';
import { recordCheck } from '../src/monitoring';
import { createProject } from '../src/queries';
import { alerts, projects } from '../src/schema';
import { makeEndpoint, makeProject, makeUser, openTestDb, truncateAll } from './test-db';

const handle = openTestDb();
const { db } = handle;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await handle.close();
});

describe('slugify', () => {
  it.each([
    ['Acme Corp.', 'acme-corp'],
    ['  Café  Crème & Co ', 'cafe-creme-co'],
    ['!!!', 'client'],
    ['a'.repeat(80), 'a'.repeat(48)],
  ])('%s → %s', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe('clients', () => {
  it('creates clients with unique slugs per user and keeps the slug on rename', async () => {
    const user = await makeUser(db);
    const first = await createClient(db, user.id, { name: 'Acme', contactEmail: 'ops@acme.example', notes: 'Retainer' });
    const second = await createClient(db, user.id, { name: 'ACME' });
    expect([first.slug, second.slug]).toEqual(['acme', 'acme-2']);

    const renamed = await updateClient(db, user.id, first.id, { name: 'Acme Corporation', contactEmail: null, notes: 'x' });
    expect(renamed).toMatchObject({ name: 'Acme Corporation', slug: 'acme', contactEmail: null, notes: 'x' });
    expect(await getClientBySlug(db, user.id, 'acme')).toMatchObject({ id: first.id });
  });

  it('deleting a client unassigns its projects and never deletes them', async () => {
    const user = await makeUser(db);
    const client = await createClient(db, user.id, { name: 'Acme' });
    const project = await createProject(db, {
      ownerId: user.id,
      name: 'shop',
      repoFullName: 'acme/shop',
      apiTokenHash: 'h',
      apiTokenHint: 'h',
      clientId: client.id,
    });
    expect(await deleteClient(db, user.id, client.id)).toBe(true);
    const [after] = await db.select().from(projects).where(eq(projects.id, project.id));
    expect(after).toMatchObject({ id: project.id, clientId: null });
  });

  it('builds the /clients overview: clients with their projects, then unassigned, with uptime badges', async () => {
    const user = await makeUser(db);
    await createClient(db, user.id, { name: 'Zeta' });
    const acme = await createClient(db, user.id, { name: 'acme' });
    const shop = await makeProject(db, user.id, 'shop');
    await makeProject(db, user.id, 'blog');
    const api = await makeProject(db, user.id, 'api');
    await assignProjectToClient(db, user.id, shop.id, acme.id);
    await assignProjectToClient(db, user.id, api.id, acme.id);

    // shop: an open alert → down. api: latest check failed → degraded. blog: no endpoints.
    const shopEndpoint = await makeEndpoint(db, shop.id);
    await db.insert(alerts).values({ projectId: shop.id, endpointId: shopEndpoint.id, kind: 'endpoint_down', message: 'down' });
    const apiEndpoint = await makeEndpoint(db, api.id);
    await recordCheck(db, apiEndpoint.id, { checkedAt: new Date(), statusCode: 500, latencyMs: 10, ok: false, error: 'x' });

    const overview = await listClientsOverview(db, user.id);
    expect(overview.clients.map((c) => [c.name, c.projects.map((p) => `${p.name}:${p.uptime}`)])).toEqual([
      ['acme', ['api:degraded', 'shop:down']],
      ['Zeta', []],
    ]);
    expect(overview.unassigned.map((p) => `${p.name}:${p.uptime}`)).toEqual(['blog:no_endpoints']);
  });

  it('reports up when every checked endpoint is ok, and can unassign a project', async () => {
    const user = await makeUser(db);
    const client = await createClient(db, user.id, { name: 'Acme' });
    const project = await makeProject(db, user.id, 'shop');
    await assignProjectToClient(db, user.id, project.id, client.id);
    const endpoint = await makeEndpoint(db, project.id);
    await makeEndpoint(db, project.id); // never checked: doesn't count against "up"
    await recordCheck(db, endpoint.id, { checkedAt: new Date(), statusCode: 200, latencyMs: 10, ok: true, error: null });

    expect((await listClientsOverview(db, user.id)).clients[0]?.projects[0]?.uptime).toBe('up');
    expect(await assignProjectToClient(db, user.id, project.id, null)).toBe(true);
    expect((await listClientsOverview(db, user.id)).unassigned.map((p) => p.name)).toEqual(['shop']);
  });
});

describe('deploy notes', () => {
  it('are saved with the project settings, kept when omitted and cleared with null', async () => {
    const user = await makeUser(db);
    const project = await makeProject(db, user.id);
    const notesOf = async () => (await db.select({ n: projects.deployNotes }).from(projects).where(eq(projects.id, project.id)))[0]?.n;
    await updateProjectSettings(db, user.id, project.id, { clientId: null, alertWebhookUrl: null, deployNotes: '## Deploy\n\nPush to main.' });
    expect(await notesOf()).toBe('## Deploy\n\nPush to main.');
    await updateProjectSettings(db, user.id, project.id, { clientId: null, alertWebhookUrl: null });
    expect(await notesOf()).toBe('## Deploy\n\nPush to main.');
    await updateProjectSettings(db, user.id, project.id, { clientId: null, alertWebhookUrl: null, deployNotes: null });
    expect(await notesOf()).toBeNull();
    // Another user can't set them.
    expect(await updateProjectSettings(db, (await makeUser(db)).id, project.id, { clientId: null, alertWebhookUrl: null, deployNotes: 'x' })).toBe(false);
  });
});

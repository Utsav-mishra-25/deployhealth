import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { listProjectsForOwner, type ProjectListItem } from './queries';
import { clients, projects, type Client } from './schema';

// Every function takes the signed-in user's id and never touches another user's rows.

/** "Acme Corp." → "acme-corp"; falls back to "client" when nothing usable is left. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return slug || 'client';
}

export interface ClientInput {
  name: string;
  contactEmail?: string | null;
  notes?: string | null;
}

/** Create a client with a slug unique for this user ("acme", then "acme-2", "acme-3", …). */
export async function createClient(db: Db, userId: string, input: ClientInput): Promise<Client> {
  const base = slugify(input.name);
  for (let attempt = 1; attempt <= 50; attempt++) {
    const slug = attempt === 1 ? base : `${base}-${attempt}`;
    const [client] = await db
      .insert(clients)
      .values({ userId, name: input.name, slug, contactEmail: input.contactEmail ?? null, notes: input.notes ?? null })
      .onConflictDoNothing({ target: [clients.userId, clients.slug] })
      .returning();
    if (client) return client;
  }
  throw new Error(`Could not find a free slug for "${input.name}"`);
}

export async function listClients(db: Db, userId: string): Promise<Client[]> {
  return db.select().from(clients).where(eq(clients.userId, userId)).orderBy(asc(sql`lower(${clients.name})`));
}

export async function getClientBySlug(db: Db, userId: string, slug: string): Promise<Client | null> {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.userId, userId), eq(clients.slug, slug)));
  return client ?? null;
}

export async function getClientForOwner(db: Db, userId: string, clientId: string): Promise<Client | null> {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.userId, userId), eq(clients.id, clientId)));
  return client ?? null;
}

/** Rename or edit a client. The slug stays the same so links keep working. */
export async function updateClient(db: Db, userId: string, clientId: string, input: ClientInput): Promise<Client | null> {
  const [client] = await db
    .update(clients)
    .set({ name: input.name, contactEmail: input.contactEmail ?? null, notes: input.notes ?? null })
    .where(and(eq(clients.userId, userId), eq(clients.id, clientId)))
    .returning();
  return client ?? null;
}

/** Delete a client. Its projects are unassigned (FK on delete set null), never deleted. */
export async function deleteClient(db: Db, userId: string, clientId: string): Promise<boolean> {
  const deleted = await db
    .delete(clients)
    .where(and(eq(clients.userId, userId), eq(clients.id, clientId)))
    .returning({ id: clients.id });
  return deleted.length === 1;
}

/** SQL condition: `clientId` is null or a client owned by `userId`. */
function clientOwnedBy(clientId: string | null, userId: string) {
  return clientId === null
    ? sql`true`
    : sql`exists (select 1 from ${clients} where ${clients.id} = ${clientId} and ${clients.userId} = ${userId})`;
}

export interface ProjectSettingsInput {
  clientId: string | null;
  alertWebhookUrl: string | null;
  /** Markdown for the handoff's "How to deploy"; null clears it, omitted keeps it. */
  deployNotes?: string | null;
}

/**
 * Update a project's client and webhook. False if the project isn't the user's, or the client
 * isn't (a project can't be attached to someone else's client).
 */
export async function updateProjectSettings(
  db: Db,
  ownerId: string,
  projectId: string,
  input: ProjectSettingsInput,
): Promise<boolean> {
  const updated = await db
    .update(projects)
    .set({ clientId: input.clientId, alertWebhookUrl: input.alertWebhookUrl, deployNotes: input.deployNotes })
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId), clientOwnedBy(input.clientId, ownerId)))
    .returning({ id: projects.id });
  return updated.length === 1;
}

/** Assign (or with null, unassign) a project to one of the user's clients. */
export async function assignProjectToClient(
  db: Db,
  ownerId: string,
  projectId: string,
  clientId: string | null,
): Promise<boolean> {
  const updated = await db
    .update(projects)
    .set({ clientId })
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId), clientOwnedBy(clientId, ownerId)))
    .returning({ id: projects.id });
  return updated.length === 1;
}

export interface ClientsOverview {
  clients: Array<Client & { projects: ProjectListItem[] }>;
  /** Projects without a client ("No client"). */
  unassigned: ProjectListItem[];
}

/** Everything the /clients page shows: each client with its projects, plus unassigned projects. */
export async function listClientsOverview(db: Db, userId: string): Promise<ClientsOverview> {
  const [clientRows, projectRows] = await Promise.all([listClients(db, userId), listProjectsForOwner(db, userId)]);
  const byClient = new Map<string, ProjectListItem[]>();
  const unassigned: ProjectListItem[] = [];
  for (const project of projectRows) {
    if (project.clientId) byClient.set(project.clientId, [...(byClient.get(project.clientId) ?? []), project]);
    else unassigned.push(project);
  }
  const byName = (a: ProjectListItem, b: ProjectListItem) => a.name.localeCompare(b.name);
  return {
    clients: clientRows.map((c) => ({ ...c, projects: (byClient.get(c.id) ?? []).sort(byName) })),
    unassigned: unassigned.sort(byName),
  };
}

import { getProjectForOwner, listEndpointsForOwner, type Db } from '@deployhealth/db';
import type { AlertDestination } from './onboarding';

type Queries = { getProjectForOwner: typeof getProjectForOwner; listEndpointsForOwner: typeof listEndpointsForOwner };

/**
 * The checklist's "Choose where alerts go" for one user, from owner-scoped queries only (no list
 * query returns whether a webhook is set). Each project's webhook becomes a boolean here and goes
 * no further: only `AlertDestination` reaches the page. With a webhook anywhere it stops there;
 * else it finds the oldest project with an endpoint, reading endpoints one project at a time.
 */
export async function alertDestination(
  db: Db,
  ownerId: string,
  state: { projects: readonly { id: string }[]; endpoints: number },
  queries: Queries = { getProjectForOwner, listEndpointsForOwner },
): Promise<AlertDestination> {
  const rows = await Promise.all(state.projects.map((p) => queries.getProjectForOwner(db, p.id, ownerId)));
  if (rows.some((project) => Boolean(project?.alertWebhookUrl))) return { webhookSet: true, projectId: null };
  if (state.endpoints === 0) return { webhookSet: false, projectId: null };
  for (const project of state.projects) {
    const endpoints = await queries.listEndpointsForOwner(db, ownerId, project.id);
    if (endpoints.length > 0) return { webhookSet: false, projectId: project.id };
  }
  return { webhookSet: false, projectId: null };
}

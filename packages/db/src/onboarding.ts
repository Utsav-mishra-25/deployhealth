import { asc, count, eq } from 'drizzle-orm';
import type { Db } from './client';
import { listInstallationsForUser, type InstallationSummary } from './github';
import { clients, deploys, endpoints, projects } from './schema';

export interface OnboardingProject {
  id: string;
  name: string;
  repoFullName: string;
}

/** What the first-run checklist on /clients reads. Everything is the user's own. */
export interface OnboardingState {
  /** The user's linked installations (`listInstallationsForUser`), suspended ones included. */
  installations: InstallationSummary[];
  /** Oldest first. */
  projects: OnboardingProject[];
  endpoints: number;
  deploys: number;
  clients: number;
}

/**
 * The first-run checklist's data for one user: their linked installations (with the repositories
 * each covers, for web's coverage notes), their projects and how many endpoints, deploys and
 * clients they have. Owner-scoped: another user's rows never count, even for the same
 * repository or account.
 */
export async function getOnboardingState(db: Db, userId: string): Promise<OnboardingState> {
  const [installations, owned, [endpointRow], [deployRow], [clientRow]] = await Promise.all([
    listInstallationsForUser(db, userId),
    db
      .select({ id: projects.id, name: projects.name, repoFullName: projects.repoFullName })
      .from(projects)
      .where(eq(projects.ownerId, userId))
      .orderBy(asc(projects.createdAt), asc(projects.name)),
    db.select({ n: count() }).from(endpoints).innerJoin(projects, eq(projects.id, endpoints.projectId)).where(eq(projects.ownerId, userId)),
    db.select({ n: count() }).from(deploys).innerJoin(projects, eq(projects.id, deploys.projectId)).where(eq(projects.ownerId, userId)),
    db.select({ n: count() }).from(clients).where(eq(clients.userId, userId)),
  ]);
  return {
    installations,
    projects: owned,
    endpoints: endpointRow?.n ?? 0,
    deploys: deployRow?.n ?? 0,
    clients: clientRow?.n ?? 0,
  };
}

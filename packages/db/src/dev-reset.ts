import { eq, or } from 'drizzle-orm';
import type { Db } from './client';
import { DEV_GITHUB_ID } from './demo';
import { clients, installations, projects, users } from './schema';

// Test tooling only (apps/web e2e: the first-run flow on a fresh account). Not exported from the
// package index and never called by the apps.

/**
 * Empties the local dev account (github_id -2): its projects (deploys, scans, endpoints, checks,
 * alerts and pull request checks cascade), its clients, and the installations linked to it or
 * installed from its GitHub id (their repositories cascade). The user row stays, so a minted
 * session keeps working. Scoped to the dev user alone: the demo user's rows and the demo's
 * installation are never touched (test/dev-reset.test.ts). Returns what it removed.
 */
export async function resetDevUser(db: Db): Promise<{ projects: number; clients: number; installations: number }> {
  return db.transaction(async (tx) => {
    const [dev] = await tx.select({ id: users.id }).from(users).where(eq(users.githubId, DEV_GITHUB_ID));
    if (!dev) return { projects: 0, clients: 0, installations: 0 };
    const removedInstallations = await tx
      .delete(installations)
      .where(or(eq(installations.userId, dev.id), eq(installations.installerGithubId, DEV_GITHUB_ID)))
      .returning({ id: installations.id });
    const removedProjects = await tx.delete(projects).where(eq(projects.ownerId, dev.id)).returning({ id: projects.id });
    const removedClients = await tx.delete(clients).where(eq(clients.userId, dev.id)).returning({ id: clients.id });
    return { projects: removedProjects.length, clients: removedClients.length, installations: removedInstallations.length };
  });
}

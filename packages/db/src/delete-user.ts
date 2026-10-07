import { count, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Db } from './client';
import {
  alerts,
  checks,
  clients,
  deploys,
  endpointDailyStats,
  endpoints,
  findings,
  installationRepos,
  installations,
  prChecks,
  projects,
  scans,
  scanVariables,
  users,
} from './schema';

// Deleting an account on request (/privacy promises it within DELETION_REQUEST_DAYS). Operator
// only: `delete-user-cli.ts`, never a route. Scoped to the one user it is given, like every query.

/** Who to delete: a GitHub login (case-insensitive) or a GitHub user id. */
export type UserSelector = { login: string } | { githubId: number };

/** Every table that holds rows a user owns, in the order the counts are printed. */
export const DELETION_TABLES = [
  'users',
  'clients',
  'projects',
  'deploys',
  'scans',
  'findings',
  'scan_variables',
  'endpoints',
  'checks',
  'endpoint_daily_stats',
  'alerts',
  'installations',
  'installation_repos',
  'pr_checks',
] as const;
export type DeletionTable = (typeof DELETION_TABLES)[number];
export type DeletionCounts = Record<DeletionTable, number>;

export interface UserDeletion {
  user: { id: string; login: string; githubId: number };
  /** Rows per table: what would go (plan) or what went (delete). */
  counts: DeletionCounts;
}

/** Why a deletion was refused; the message is safe to print (logins and ids only). */
export class UserDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserDeletionError';
  }
}

/** Counts per table, changing nothing. */
export async function planUserDeletion(db: Db, selector: UserSelector): Promise<UserDeletion> {
  const user = await findUser(db, selector);
  return { user, counts: await countOwned(db, user) };
}

/**
 * Delete the user and everything they own, in one transaction: their row (clients, projects and
 * everything under them cascade) and the GitHub App installations linked to them or installed by
 * them (their repo lists and pull request checks cascade). Returns what was deleted.
 */
export async function deleteUser(db: Db, selector: UserSelector): Promise<UserDeletion> {
  return db.transaction(async (tx) => {
    const user = await findUser(tx, selector);
    const counts = await countOwned(tx, user);
    await tx.delete(installations).where(ownedInstallation(user));
    await tx.delete(users).where(eq(users.id, user.id));
    return { user, counts };
  });
}

async function findUser(db: Db, selector: UserSelector): Promise<UserDeletion['user']> {
  const where = 'githubId' in selector ? eq(users.githubId, selector.githubId) : sql`lower(${users.login}) = lower(${selector.login})`;
  const found = await db.select({ id: users.id, login: users.login, githubId: users.githubId }).from(users).where(where);
  const label = 'githubId' in selector ? `GitHub id ${selector.githubId}` : `login "${selector.login}"`;
  if (found.length === 0) throw new UserDeletionError(`No user with ${label}.`);
  if (found.length > 1) {
    throw new UserDeletionError(`${found.length} users have ${label}; run again with --github-id (${found.map((u) => u.githubId).join(', ')}).`);
  }
  const user = found[0]!;
  // GitHub ids are positive: -1 is the public demo, -2 the dev login, and nothing else is real.
  if (user.githubId <= 0) throw new UserDeletionError(`Refusing to delete "${user.login}" (GitHub id ${user.githubId}): it is the demo or dev user.`);
  return user;
}

function ownedInstallation(user: UserDeletion['user']): SQL {
  return or(eq(installations.userId, user.id), eq(installations.installerGithubId, user.githubId))!;
}

async function countOwned(db: Db, user: UserDeletion['user']): Promise<DeletionCounts> {
  const projectIds = db.select({ id: projects.id }).from(projects).where(eq(projects.ownerId, user.id));
  const deployIds = db.select({ id: deploys.id }).from(deploys).where(inArray(deploys.projectId, projectIds));
  const scanIds = db.select({ id: scans.id }).from(scans).where(inArray(scans.deployId, deployIds));
  const endpointIds = db.select({ id: endpoints.id }).from(endpoints).where(inArray(endpoints.projectId, projectIds));
  const installationIds = db.select({ id: installations.id }).from(installations).where(ownedInstallation(user));

  const rows = (table: PgTable, where: SQL | undefined) =>
    db
      .select({ n: count() })
      .from(table)
      .where(where)
      .then(([row]) => row?.n ?? 0);

  return {
    users: await rows(users, eq(users.id, user.id)),
    clients: await rows(clients, eq(clients.userId, user.id)),
    projects: await rows(projects, eq(projects.ownerId, user.id)),
    deploys: await rows(deploys, inArray(deploys.projectId, projectIds)),
    scans: await rows(scans, inArray(scans.deployId, deployIds)),
    findings: await rows(findings, inArray(findings.scanId, scanIds)),
    scan_variables: await rows(scanVariables, inArray(scanVariables.scanId, scanIds)),
    endpoints: await rows(endpoints, inArray(endpoints.projectId, projectIds)),
    checks: await rows(checks, inArray(checks.endpointId, endpointIds)),
    endpoint_daily_stats: await rows(endpointDailyStats, inArray(endpointDailyStats.endpointId, endpointIds)),
    alerts: await rows(alerts, inArray(alerts.projectId, projectIds)),
    installations: await rows(installations, ownedInstallation(user)),
    installation_repos: await rows(installationRepos, inArray(installationRepos.installationId, installationIds)),
    pr_checks: await rows(prChecks, or(inArray(prChecks.projectId, projectIds), inArray(prChecks.installationId, installationIds))),
  };
}

import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  installationRepos,
  installations,
  prChecks,
  projects,
  users,
  webhookDeliveries,
  type Installation,
  type NewPrCheck,
  type PrCheck,
  type PrCheckMode,
} from './schema';

// ---------------------------------------------------------------------------------------------
// Webhook deliveries (dedupe)
// ---------------------------------------------------------------------------------------------

/** Remember a delivery id. False if it was already recorded (a redelivery or a retry). */
export async function recordDelivery(db: Db, deliveryId: string, now = new Date()): Promise<boolean> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values({ deliveryId, receivedAt: now })
    .onConflictDoNothing()
    .returning({ id: webhookDeliveries.deliveryId });
  return inserted.length === 1;
}

/** Undo `recordDelivery` when handling failed, so GitHub's redelivery is processed. */
export async function forgetDelivery(db: Db, deliveryId: string): Promise<void> {
  await db.delete(webhookDeliveries).where(eq(webhookDeliveries.deliveryId, deliveryId));
}

/** Nightly: delivery ids older than `olderThan` (24 h) can't be redelivered usefully any more. */
export async function pruneDeliveries(db: Db, olderThan: Date): Promise<number> {
  const deleted = await db.delete(webhookDeliveries).where(lt(webhookDeliveries.receivedAt, olderThan)).returning({ id: webhookDeliveries.deliveryId });
  return deleted.length;
}

// ---------------------------------------------------------------------------------------------
// Installations, from signed webhook deliveries (keyed by GitHub ids, not by a signed-in user)
// ---------------------------------------------------------------------------------------------

export interface InstallationInput {
  githubInstallationId: number;
  accountLogin: string;
  accountType: string;
  /** The delivery's sender: the GitHub account that installed the App. */
  installerGithubId: number;
}

/**
 * Create or refresh an installation, replace its repository list when `repos` is given, and link
 * it to the deployhealth user with the installer's GitHub id if there is one.
 */
export async function upsertInstallation(db: Db, input: InstallationInput, repos?: readonly string[]): Promise<Installation> {
  return db.transaction(async (tx) => {
    const [installer] = await tx.select({ id: users.id }).from(users).where(eq(users.githubId, input.installerGithubId));
    const [row] = await tx
      .insert(installations)
      .values({ ...input, userId: installer?.id ?? null })
      .onConflictDoUpdate({
        target: installations.githubInstallationId,
        set: {
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          suspendedAt: null,
          // Keep an existing link; otherwise link to the installer if they have an account.
          userId: sql`coalesce(${installations.userId}, ${installer?.id ?? null}::uuid)`,
        },
      })
      .returning();
    if (repos) {
      await tx.delete(installationRepos).where(eq(installationRepos.installationId, row!.id));
      await insertRepos(tx, row!.id, repos);
    }
    return row!;
  });
}

async function insertRepos(db: Db, installationId: string, repos: readonly string[]): Promise<void> {
  if (repos.length === 0) return;
  await db
    .insert(installationRepos)
    .values([...new Set(repos)].map((repoFullName) => ({ installationId, repoFullName })))
    .onConflictDoNothing();
}

async function installationByGithubId(db: Db, githubInstallationId: number): Promise<Installation | null> {
  const [row] = await db.select().from(installations).where(eq(installations.githubInstallationId, githubInstallationId));
  return row ?? null;
}

/** installation_repositories: added / removed. Unknown installations are ignored (false). */
export async function changeInstallationRepos(
  db: Db,
  githubInstallationId: number,
  { added = [], removed = [] }: { added?: readonly string[]; removed?: readonly string[] },
): Promise<boolean> {
  const installation = await installationByGithubId(db, githubInstallationId);
  if (!installation) return false;
  await insertRepos(db, installation.id, added);
  if (removed.length > 0) {
    await db
      .delete(installationRepos)
      .where(and(eq(installationRepos.installationId, installation.id), inArray(installationRepos.repoFullName, [...removed])));
  }
  return true;
}

/** installation: suspend / unsuspend. */
export async function setInstallationSuspended(db: Db, githubInstallationId: number, suspendedAt: Date | null): Promise<void> {
  await db.update(installations).set({ suspendedAt }).where(eq(installations.githubInstallationId, githubInstallationId));
}

/** installation: deleted. Its repos and pull request checks go with it. */
export async function deleteInstallation(db: Db, githubInstallationId: number): Promise<void> {
  await db.delete(installations).where(eq(installations.githubInstallationId, githubInstallationId));
}

/** At sign-in: link installations this GitHub account made before it had a deployhealth account. */
export async function linkInstallationsForUser(db: Db, userId: string, githubId: number): Promise<number> {
  const linked = await db
    .update(installations)
    .set({ userId })
    .where(and(eq(installations.installerGithubId, githubId), isNull(installations.userId)))
    .returning({ id: installations.id });
  return linked.length;
}

/** pull_request: closed (null reopens). Marks every check of that pull request. */
export async function markPullRequestClosed(
  db: Db,
  githubInstallationId: number,
  repoFullName: string,
  prNumber: number,
  closedAt: Date | null,
): Promise<number> {
  const updated = await db
    .update(prChecks)
    .set({ closedAt, updatedAt: sql`now()` })
    .where(
      and(
        eq(prChecks.prNumber, prNumber),
        inArray(
          prChecks.installationId,
          db.select({ id: installations.id }).from(installations).where(eq(installations.githubInstallationId, githubInstallationId)),
        ),
        inArray(
          prChecks.projectId,
          db.select({ id: projects.id }).from(projects).where(sql`lower(${projects.repoFullName}) = lower(${repoFullName})`),
        ),
      ),
    )
    .returning({ id: prChecks.id });
  return updated.length;
}

// ---------------------------------------------------------------------------------------------
// The worker's pr-check job
// ---------------------------------------------------------------------------------------------

export interface PrCheckTarget {
  installationId: string;
  project: { id: string; name: string; prCheckMode: PrCheckMode };
}

/**
 * The project a pull request is checked for: owned by the user linked to the installation, with a
 * matching repo (case-insensitive) that the installation can see, installation not suspended.
 * The oldest such project if the user has several for one repo. Null: nothing to do.
 */
export async function findPrCheckTarget(db: Db, githubInstallationId: number, repoFullName: string): Promise<PrCheckTarget | null> {
  const [row] = await db
    .select({ installationId: installations.id, id: projects.id, name: projects.name, prCheckMode: projects.prCheckMode })
    .from(installations)
    .innerJoin(
      installationRepos,
      and(eq(installationRepos.installationId, installations.id), sql`lower(${installationRepos.repoFullName}) = lower(${repoFullName})`),
    )
    .innerJoin(projects, and(eq(projects.ownerId, installations.userId), sql`lower(${projects.repoFullName}) = lower(${repoFullName})`))
    .where(and(eq(installations.githubInstallationId, githubInstallationId), isNull(installations.suspendedAt)))
    .orderBy(projects.createdAt)
    .limit(1);
  if (!row) return null;
  return { installationId: row.installationId, project: { id: row.id, name: row.name, prCheckMode: row.prCheckMode } };
}

/** The comment already posted on this pull request for this project, if any (newest first). */
export async function findPrCommentId(db: Db, projectId: string, prNumber: number): Promise<number | null> {
  const [row] = await db
    .select({ commentId: prChecks.commentId })
    .from(prChecks)
    .where(and(eq(prChecks.projectId, projectId), eq(prChecks.prNumber, prNumber), sql`${prChecks.commentId} is not null`))
    .orderBy(desc(prChecks.updatedAt))
    .limit(1);
  return row?.commentId ?? null;
}

/**
 * Store the result for one head (unique per project + pull request + head sha). Re-running the
 * same head updates the row and keeps its comment and check run ids unless new ones are given.
 */
export async function upsertPrCheck(db: Db, input: Omit<NewPrCheck, 'id' | 'createdAt' | 'updatedAt' | 'closedAt'>): Promise<PrCheck> {
  const { commentId, checkRunId, ...rest } = input;
  const [row] = await db
    .insert(prChecks)
    .values(input)
    .onConflictDoUpdate({
      target: [prChecks.projectId, prChecks.prNumber, prChecks.headSha],
      set: {
        ...rest,
        closedAt: null,
        updatedAt: sql`now()`,
        ...(commentId !== undefined ? { commentId } : {}),
        ...(checkRunId !== undefined ? { checkRunId } : {}),
      },
    })
    .returning();
  return row!;
}

export async function setPrCheckGithubIds(db: Db, id: string, ids: { commentId?: number | null; checkRunId?: number | null }): Promise<void> {
  await db
    .update(prChecks)
    .set({ ...ids, updatedAt: sql`now()` })
    .where(eq(prChecks.id, id));
}

// ---------------------------------------------------------------------------------------------
// Signed-in reads and writes (owner-scoped)
// ---------------------------------------------------------------------------------------------

export type GithubAppStatus =
  | { state: 'not-installed' }
  | { state: 'active'; accountLogin: string }
  | { state: 'suspended'; accountLogin: string }
  /** Installed on the repo, but by a GitHub account that isn't this user's. */
  | { state: 'other-account'; accountLogin: string };

/** Whether the App can check this owner's project, and why not. Null if the project isn't theirs. */
export async function getGithubAppStatus(db: Db, ownerId: string, projectId: string): Promise<GithubAppStatus | null> {
  const [project] = await db
    .select({ repoFullName: projects.repoFullName })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
  if (!project) return null;
  const rows = await db
    .select({ accountLogin: installations.accountLogin, userId: installations.userId, suspendedAt: installations.suspendedAt })
    .from(installations)
    .innerJoin(installationRepos, eq(installationRepos.installationId, installations.id))
    .where(sql`lower(${installationRepos.repoFullName}) = lower(${project.repoFullName})`);
  const mine = rows.find((r) => r.userId === ownerId);
  if (mine) return mine.suspendedAt ? { state: 'suspended', accountLogin: mine.accountLogin } : { state: 'active', accountLogin: mine.accountLogin };
  return rows[0] ? { state: 'other-account', accountLogin: rows[0].accountLogin } : { state: 'not-installed' };
}

export async function updatePrCheckMode(db: Db, ownerId: string, projectId: string, mode: PrCheckMode): Promise<boolean> {
  const updated = await db
    .update(projects)
    .set({ prCheckMode: mode })
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .returning({ id: projects.id });
  return updated.length === 1;
}

export interface PrCheckListItem {
  prNumber: number;
  headSha: string;
  authorLogin: string;
  authorIsAgent: boolean;
  agentName: string | null;
  conclusion: PrCheck['conclusion'];
  undeclared: number;
  secretHits: number;
  closed: boolean;
  checkedAt: Date;
}

/** The latest check of each of the project's pull requests, most recently checked first. */
export async function listPrChecksForOwner(db: Db, ownerId: string, projectId: string, limit = 20): Promise<PrCheckListItem[]> {
  const result = await db.execute<{
    pr_number: number;
    head_sha: string;
    author_login: string;
    author_is_agent: boolean;
    agent_name: string | null;
    conclusion: PrCheck['conclusion'];
    undeclared: number;
    secret_hits: number;
    closed_at: string | null;
    updated_at: string;
  }>(sql`
    select * from (
      select distinct on (pc.pr_number) pc.pr_number, pc.head_sha, pc.author_login, pc.author_is_agent, pc.agent_name,
             pc.conclusion, jsonb_array_length(pc.undeclared_vars)::int as undeclared, pc.secret_hits, pc.closed_at, pc.updated_at
      from ${prChecks} pc
      join ${projects} p on p.id = pc.project_id
      where pc.project_id = ${projectId} and p.owner_id = ${ownerId}
      order by pc.pr_number, pc.created_at desc
    ) latest
    order by updated_at desc
    limit ${limit}
  `);
  return result.rows.map((r) => ({
    prNumber: r.pr_number,
    headSha: r.head_sha,
    authorLogin: r.author_login,
    authorIsAgent: r.author_is_agent,
    agentName: r.agent_name,
    conclusion: r.conclusion,
    undeclared: r.undeclared,
    secretHits: r.secret_hits,
    closed: r.closed_at !== null,
    checkedAt: new Date(r.updated_at),
  }));
}

/**
 * For a client's page: pull requests by coding agents in [from, to) across the client's projects
 * (owned by `ownerId`), each counted once, and how many of them still add undeclared env vars
 * in their latest check in that range. "N of M" is { undeclared: N, total: M }.
 */
export async function agentPrStats(db: Db, ownerId: string, clientId: string, from: Date, to: Date): Promise<{ undeclared: number; total: number }> {
  const result = await db.execute<{ total: number; undeclared: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where jsonb_array_length(latest.undeclared_vars) > 0)::int as undeclared
    from (
      select distinct on (pc.project_id, pc.pr_number) pc.undeclared_vars
      from ${prChecks} pc
      join ${projects} p on p.id = pc.project_id
      where p.client_id = ${clientId} and p.owner_id = ${ownerId}
        and pc.created_at >= ${from.toISOString()}::timestamptz and pc.created_at < ${to.toISOString()}::timestamptz
        and pc.author_is_agent
      order by pc.project_id, pc.pr_number, pc.created_at desc
    ) latest
  `);
  return result.rows[0] ?? { total: 0, undeclared: 0 };
}

export interface InstallationRepo {
  fullName: string;
  /** This user's project for the repo (case-insensitive; the oldest if several), or null: none yet. */
  projectId: string | null;
}

export interface InstallationSummary {
  accountLogin: string;
  accountType: string;
  suspended: boolean;
  repos: InstallationRepo[];
}

/**
 * The installations linked to this user, with the repositories each can see and the user's own
 * project for each (never another user's, even for the same repository).
 */
export async function listInstallationsForUser(db: Db, userId: string): Promise<InstallationSummary[]> {
  const rows = await db
    .select({ id: installations.id, accountLogin: installations.accountLogin, accountType: installations.accountType, suspendedAt: installations.suspendedAt, repo: installationRepos.repoFullName })
    .from(installations)
    .leftJoin(installationRepos, eq(installationRepos.installationId, installations.id))
    .where(eq(installations.userId, userId))
    .orderBy(installations.accountLogin, installationRepos.repoFullName);
  const owned = await db
    .select({ id: projects.id, repoFullName: projects.repoFullName })
    .from(projects)
    .where(eq(projects.ownerId, userId))
    .orderBy(projects.createdAt);
  const projectByRepo = new Map<string, string>();
  for (const p of owned) if (!projectByRepo.has(p.repoFullName.toLowerCase())) projectByRepo.set(p.repoFullName.toLowerCase(), p.id);

  const byId = new Map<string, InstallationSummary>();
  for (const r of rows) {
    const summary = byId.get(r.id) ?? { accountLogin: r.accountLogin, accountType: r.accountType, suspended: r.suspendedAt !== null, repos: [] };
    if (r.repo) summary.repos.push({ fullName: r.repo, projectId: projectByRepo.get(r.repo.toLowerCase()) ?? null });
    byId.set(r.id, summary);
  }
  return [...byId.values()];
}

/**
 * Repositories the App can check for this user but that have no project yet, so no pull request
 * is checked: distinct, sorted. Suspended installations check nothing, so they're left out.
 */
export function reposWithoutProject(summaries: readonly InstallationSummary[]): string[] {
  const repos = new Map<string, string>();
  for (const s of summaries) {
    if (s.suspended) continue;
    for (const r of s.repos) if (r.projectId === null && !repos.has(r.fullName.toLowerCase())) repos.set(r.fullName.toLowerCase(), r.fullName);
  }
  return [...repos.values()].sort((a, b) => a.localeCompare(b));
}

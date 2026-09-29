import { summarize, uptimeStatus, type FindingCounts, type FindingRow, type UptimeStatus } from '@deployhealth/core';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client';
import { failingSinceSql } from './monitoring';
import { alerts, clients, deploys, endpoints, findings, projects, scans, users, type Deploy, type Project, type Scan, type User } from './schema';

// ---------------------------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------------------------

export interface GithubProfile {
  githubId: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
}

/** Create the user on first sign-in; refresh login/name/email/avatar on later ones. */
export async function upsertGithubUser(db: Db, profile: GithubProfile): Promise<User> {
  const values = {
    githubId: profile.githubId,
    login: profile.login,
    name: profile.name ?? null,
    email: profile.email ?? null,
    avatarUrl: profile.avatarUrl ?? null,
  };
  const [user] = await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: users.githubId,
      set: { login: values.login, name: values.name, email: values.email, avatarUrl: values.avatarUrl },
    })
    .returning();
  return user!;
}

export async function getUserByGithubId(db: Db, githubId: number): Promise<User | null> {
  const [user] = await db.select().from(users).where(eq(users.githubId, githubId));
  return user ?? null;
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export class DuplicateProjectNameError extends Error {
  constructor(name: string) {
    super(`You already have a project named "${name}".`);
    this.name = 'DuplicateProjectNameError';
  }
}

export class ClientNotFoundError extends Error {
  constructor() {
    super('That client does not exist.');
    this.name = 'ClientNotFoundError';
  }
}

export interface NewProjectInput {
  ownerId: string;
  name: string;
  repoFullName: string;
  apiTokenHash: string;
  apiTokenHint: string;
  /** Must be one of the owner's clients. */
  clientId?: string | null;
}

export async function createProject(db: Db, input: NewProjectInput): Promise<Project> {
  if (input.clientId) {
    const [owned] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, input.clientId), eq(clients.userId, input.ownerId)));
    if (!owned) throw new ClientNotFoundError();
  }
  try {
    const [project] = await db.insert(projects).values(input).returning();
    return project!;
  } catch (error) {
    const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
    if (cause?.code === '23505' && cause.constraint === 'projects_owner_name_uq') {
      throw new DuplicateProjectNameError(input.name);
    }
    throw error;
  }
}

/** A project, only if `ownerId` owns it. Every page and action goes through this check. */
export async function getProjectForOwner(db: Db, projectId: string, ownerId: string): Promise<Project | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
  return project ?? null;
}

export async function findProjectByTokenHash(db: Db, apiTokenHash: string): Promise<Project | null> {
  const [project] = await db.select().from(projects).where(eq(projects.apiTokenHash, apiTokenHash));
  return project ?? null;
}

/** Replace a project's token. Returns false if the project doesn't exist or isn't owned by `ownerId`. */
export async function rotateProjectToken(
  db: Db,
  projectId: string,
  ownerId: string,
  token: { apiTokenHash: string; apiTokenHint: string },
): Promise<boolean> {
  const updated = await db
    .update(projects)
    .set(token)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)))
    .returning({ id: projects.id });
  return updated.length === 1;
}

export interface ProjectListItem {
  id: string;
  name: string;
  repoFullName: string;
  clientId: string | null;
  createdAt: Date;
  lastDeploy: { sha: string; branch: string; deployedAt: Date } | null;
  counts: FindingCounts | null;
  uptime: UptimeStatus;
  /**
   * When the failure behind a down or degraded badge began: the earliest first failed check of
   * the current runs of the endpoints with an open alert (down) or failing now (degraded).
   */
  failingSince: Date | null;
}

/** The owner's projects, newest first, each with its latest deploy and that deploy's latest scan. */
export async function listProjectsForOwner(db: Db, ownerId: string): Promise<ProjectListItem[]> {
  const result = await db.execute<{
    id: string;
    name: string;
    repo_full_name: string;
    client_id: string | null;
    created_at: string;
    sha: string | null;
    branch: string | null;
    deployed_at: string | null;
    missing_count: number | null;
    unused_count: number | null;
    mismatch_count: number | null;
    enabled_endpoints: number;
    open_alerts: number;
    failing_endpoints: number;
    down_since: string | null;
    failing_since: string | null;
  }>(sql`
    select p.id, p.name, p.repo_full_name, p.client_id, p.created_at,
           d.sha, d.branch, d.deployed_at,
           s.missing_count, s.unused_count, s.mismatch_count,
           u.enabled_endpoints, u.open_alerts, u.failing_endpoints, u.down_since, u.failing_since
    from ${projects} p
    left join lateral (
      select id, sha, branch, deployed_at from ${deploys}
      where project_id = p.id order by deployed_at desc limit 1
    ) d on true
    left join lateral (
      select missing_count, unused_count, mismatch_count from ${scans}
      where deploy_id = d.id order by created_at desc limit 1
    ) s on true
    left join lateral (
      select count(*)::int as enabled_endpoints,
             count(*) filter (where ep.open_alert)::int as open_alerts,
             count(ep.failing_since)::int as failing_endpoints,
             min(ep.failing_since) filter (where ep.open_alert) as down_since,
             min(ep.failing_since) as failing_since
      from (
        select exists (
                 select 1 from ${alerts} a where a.endpoint_id = e.id and a.resolved_at is null
               ) as open_alert,
               ${failingSinceSql(sql`e.id`)} as failing_since
        from ${endpoints} e where e.project_id = p.id and e.enabled
      ) ep
    ) u on true
    where p.owner_id = ${ownerId}
    order by p.created_at desc
  `);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    repoFullName: row.repo_full_name,
    clientId: row.client_id,
    createdAt: new Date(row.created_at),
    lastDeploy:
      row.sha && row.branch && row.deployed_at
        ? { sha: row.sha, branch: row.branch, deployedAt: new Date(row.deployed_at) }
        : null,
    counts:
      row.missing_count === null
        ? null
        : { missing: row.missing_count, unused: row.unused_count ?? 0, mismatch: row.mismatch_count ?? 0 },
    ...uptimeAndSince(row),
  }));
}

function uptimeAndSince(row: {
  enabled_endpoints: number;
  open_alerts: number;
  failing_endpoints: number;
  down_since: string | null;
  failing_since: string | null;
}): { uptime: UptimeStatus; failingSince: Date | null } {
  const uptime = uptimeStatus({
    enabledEndpoints: row.enabled_endpoints,
    openAlerts: row.open_alerts,
    failingEndpoints: row.failing_endpoints,
  });
  const since = uptime === 'down' ? row.down_since : uptime === 'degraded' ? row.failing_since : null;
  return { uptime, failingSince: since ? new Date(since) : null };
}

// ---------------------------------------------------------------------------------------------
// Deploys, scans, findings
// ---------------------------------------------------------------------------------------------

export interface RecordScanInput {
  projectId: string;
  sha: string;
  branch: string;
  deployedAt: Date;
  source?: 'ingest' | 'manual';
  findings: readonly FindingRow[];
}

export interface RecordScanResult {
  deployId: string;
  scanId: string;
  counts: FindingCounts;
}

const FINDINGS_BATCH = 1000;

/**
 * Store one scan, atomically. The deploy is created on the first report for a sha and reused
 * afterwards (its branch and time stay as first reported), so CI re-runs add scans rather than
 * duplicate deploys. Counts are always computed here, never taken from the client.
 */
export async function recordScan(db: Db, input: RecordScanInput): Promise<RecordScanResult> {
  const counts = summarize(input.findings);

  return db.transaction(async (tx) => {
    const [deploy] = await tx
      .insert(deploys)
      .values({
        projectId: input.projectId,
        sha: input.sha,
        branch: input.branch,
        deployedAt: input.deployedAt,
        source: input.source ?? 'ingest',
      })
      // A no-op update so RETURNING yields the existing row's id on conflict.
      .onConflictDoUpdate({ target: [deploys.projectId, deploys.sha], set: { sha: sql`excluded.sha` } })
      .returning({ id: deploys.id });

    const [scan] = await tx
      .insert(scans)
      .values({
        deployId: deploy!.id,
        missingCount: counts.missing,
        unusedCount: counts.unused,
        mismatchCount: counts.mismatch,
      })
      .returning({ id: scans.id });

    for (let i = 0; i < input.findings.length; i += FINDINGS_BATCH) {
      await tx.insert(findings).values(
        input.findings.slice(i, i + FINDINGS_BATCH).map((f) => ({
          scanId: scan!.id,
          kind: f.kind,
          varName: f.var_name,
          file: f.file,
          line: f.line,
          envFile: f.env_file,
        })),
      );
    }

    return { deployId: deploy!.id, scanId: scan!.id, counts };
  });
}

export interface DeployListItem {
  deploy: Deploy;
  /** Counts from the deploy's latest scan; null if it has none. */
  counts: FindingCounts | null;
  scanCount: number;
}

/** A project's deploys, newest first, each with its latest scan's counts. */
export async function listDeploys(db: Db, projectId: string, limit = 50): Promise<DeployListItem[]> {
  const latest = db
    .selectDistinctOn([scans.deployId], {
      deployId: scans.deployId,
      missing: scans.missingCount,
      unused: scans.unusedCount,
      mismatch: scans.mismatchCount,
    })
    .from(scans)
    .orderBy(scans.deployId, desc(scans.createdAt))
    .as('latest');

  const scanTotals = db
    .select({ deployId: scans.deployId, total: sql<number>`count(*)::int`.as('total') })
    .from(scans)
    .groupBy(scans.deployId)
    .as('totals');

  const rows = await db
    .select({
      deploy: deploys,
      missing: latest.missing,
      unused: latest.unused,
      mismatch: latest.mismatch,
      total: scanTotals.total,
    })
    .from(deploys)
    .leftJoin(latest, eq(latest.deployId, deploys.id))
    .leftJoin(scanTotals, eq(scanTotals.deployId, deploys.id))
    .where(eq(deploys.projectId, projectId))
    .orderBy(desc(deploys.deployedAt))
    .limit(limit);

  return rows.map((r) => ({
    deploy: r.deploy,
    counts: r.missing === null ? null : { missing: r.missing, unused: r.unused ?? 0, mismatch: r.mismatch ?? 0 },
    scanCount: r.total ?? 0,
  }));
}

export interface ScanDetail {
  deploy: Deploy;
  scan: Scan;
  findings: FindingRow[];
}

/**
 * The latest scan of one deploy with its findings, sorted by kind then name then location.
 * `deployId` must belong to `projectId`; otherwise null.
 */
export async function getLatestScan(db: Db, projectId: string, deployId: string): Promise<ScanDetail | null> {
  const [row] = await db
    .select({ deploy: deploys, scan: scans })
    .from(scans)
    .innerJoin(deploys, eq(deploys.id, scans.deployId))
    .where(and(eq(deploys.id, deployId), eq(deploys.projectId, projectId)))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  if (!row) return null;

  const rows = await db
    .select({
      kind: findings.kind,
      var_name: findings.varName,
      file: findings.file,
      line: findings.line,
      env_file: findings.envFile,
    })
    .from(findings)
    .where(eq(findings.scanId, row.scan.id))
    .orderBy(asc(findings.kind), asc(findings.varName), asc(findings.file), asc(findings.line));

  return { deploy: row.deploy, scan: row.scan, findings: rows };
}

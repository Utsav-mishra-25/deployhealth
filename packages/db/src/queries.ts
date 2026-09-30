import {
  endpointLabel,
  ENV_FILE_BASENAMES,
  summarize,
  uptimeStatus,
  type EndpointRef,
  type EnvFileBasename,
  type EnvScope,
  type FindingCounts,
  type FindingRow,
  type RequiredVariable,
  type UptimeStatus,
} from '@deployhealth/core';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { failingSinceSql } from './monitoring';
import { alerts, clients, deploys, endpoints, findings, prChecks, projects, scans, scanVariables, users, type Deploy, type Project, type Scan, type User } from './schema';

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
  /** Normally generated; the demo seed passes fixed ids so /demo links survive a reseed. */
  id?: string;
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
  /** Labels (name, else host) of the endpoints behind a down or degraded badge, longest-failing first. */
  failingEndpoints: string[];
  /** Open pull requests whose latest GitHub App check found undeclared env vars. */
  openPrsWithUndeclared: number;
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
    down_endpoints: EndpointRef[];
    failing_endpoint_refs: EndpointRef[];
    open_prs_with_undeclared: number;
  }>(sql`
    select p.id, p.name, p.repo_full_name, p.client_id, p.created_at, prs.open_prs_with_undeclared,
           d.sha, d.branch, d.deployed_at,
           s.missing_count, s.unused_count, s.mismatch_count,
           u.enabled_endpoints, u.open_alerts, u.failing_endpoints, u.down_since, u.failing_since,
           u.down_endpoints, u.failing_endpoint_refs
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
             min(ep.failing_since) as failing_since,
             coalesce(json_agg(json_build_object('url', ep.url, 'name', ep.name) order by ep.failing_since)
               filter (where ep.open_alert and ep.failing_since is not null), '[]') as down_endpoints,
             coalesce(json_agg(json_build_object('url', ep.url, 'name', ep.name) order by ep.failing_since)
               filter (where ep.failing_since is not null), '[]') as failing_endpoint_refs
      from (
        select e.url, e.name,
               exists (
                 select 1 from ${alerts} a where a.endpoint_id = e.id and a.resolved_at is null
               ) as open_alert,
               ${failingSinceSql(sql`e.id`)} as failing_since
        from ${endpoints} e where e.project_id = p.id and e.enabled
      ) ep
    ) u on true
    left join lateral (
      select count(*)::int as open_prs_with_undeclared
      from (
        select distinct on (pc.pr_number) pc.undeclared_vars, pc.closed_at
        from ${prChecks} pc where pc.project_id = p.id
        order by pc.pr_number, pc.created_at desc
      ) latest
      where latest.closed_at is null and jsonb_array_length(latest.undeclared_vars) > 0
    ) prs on true
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
    openPrsWithUndeclared: row.open_prs_with_undeclared,
  }));
}

function uptimeAndSince(row: {
  enabled_endpoints: number;
  open_alerts: number;
  failing_endpoints: number;
  down_since: string | null;
  failing_since: string | null;
  down_endpoints: EndpointRef[];
  failing_endpoint_refs: EndpointRef[];
}): { uptime: UptimeStatus; failingSince: Date | null; failingEndpoints: string[] } {
  const uptime = uptimeStatus({
    enabledEndpoints: row.enabled_endpoints,
    openAlerts: row.open_alerts,
    failingEndpoints: row.failing_endpoints,
  });
  const since = uptime === 'down' ? row.down_since : uptime === 'degraded' ? row.failing_since : null;
  const refs = uptime === 'down' ? row.down_endpoints : uptime === 'degraded' ? row.failing_endpoint_refs : [];
  return { uptime, failingSince: since ? new Date(since) : null, failingEndpoints: refs.map(endpointLabel) };
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
  /** Every referenced variable (names only). Omitted by older CLIs; the scan then says so. */
  variables?: readonly RequiredVariable[];
  /** Every scope with its env files. Omitted by CLIs before 0.2.0; stored as null. */
  envScopes?: readonly EnvScope[] | null;
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
        variablesReported: input.variables !== undefined,
        envScopes: input.envScopes ? input.envScopes.map((s) => ({ scope: s.scope, env_files: [...s.env_files] })) : null,
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

    const variables = mergeVariables(input.variables ?? []);
    for (let i = 0; i < variables.length; i += FINDINGS_BATCH) {
      await tx.insert(scanVariables).values(
        variables
          .slice(i, i + FINDINGS_BATCH)
          .map((v) => ({ scanId: scan!.id, scope: v.scope, varName: v.var_name, definedIn: v.defined_in, optional: v.optional === true })),
      );
    }

    return { deployId: deploy!.id, scanId: scan!.id, counts };
  });
}

/** One row per (scope, name); a repeated one merges its env files, and stays optional only if every copy is. */
function mergeVariables(variables: readonly RequiredVariable[]): RequiredVariable[] {
  const byKey = new Map<string, { files: Set<EnvFileBasename>; optional: boolean }>();
  for (const v of variables) {
    const key = `${v.scope}\0${v.var_name}`;
    const merged = byKey.get(key) ?? { files: new Set<EnvFileBasename>(), optional: true };
    for (const f of v.defined_in) merged.files.add(f);
    merged.optional &&= v.optional === true;
    byKey.set(key, merged);
  }
  return [...byKey].map(([key, { files, optional }]) => {
    const [scope, var_name] = key.split('\0') as [string, string];
    const variable: RequiredVariable = { scope, var_name, defined_in: ENV_FILE_BASENAMES.filter((b) => files.has(b)) };
    if (optional) variable.optional = true;
    return variable;
  });
}

/** A scan's variables, by scope ('' first) then name. `optional` is set only when true. */
export async function getScanVariables(db: Db, scanId: string): Promise<RequiredVariable[]> {
  const rows = await db
    .select({ scope: scanVariables.scope, var_name: scanVariables.varName, defined_in: scanVariables.definedIn, optional: scanVariables.optional })
    .from(scanVariables)
    .where(eq(scanVariables.scanId, scanId))
    .orderBy(asc(scanVariables.scope), asc(scanVariables.varName));
  return rows.map((r) => ({ scope: r.scope, var_name: r.var_name, defined_in: r.defined_in as EnvFileBasename[], ...(r.optional ? { optional: true as const } : {}) }));
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
  /**
   * Scopes with no env file at all, with how many variables they reference: the project page shows
   * one notice for each instead of MISSING rows. Empty for scans from CLIs before 0.2.0.
   */
  scopesWithoutEnvFiles: Array<{ scope: string; variables: number }>;
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

  const bare = (row.scan.envScopes ?? []).filter((s) => s.env_files.length === 0).map((s) => s.scope);
  const counts =
    bare.length === 0
      ? []
      : await db
          .select({ scope: scanVariables.scope, variables: sql<number>`count(*)::int` })
          .from(scanVariables)
          .where(and(eq(scanVariables.scanId, row.scan.id), inArray(scanVariables.scope, bare)))
          .groupBy(scanVariables.scope);
  const scopesWithoutEnvFiles = bare
    .map((scope) => ({ scope, variables: counts.find((c) => c.scope === scope)?.variables ?? 0 }))
    .filter((s) => s.variables > 0)
    .sort((a, b) => (a.scope === '' ? -1 : b.scope === '' ? 1 : a.scope.localeCompare(b.scope)));

  return { deploy: row.deploy, scan: row.scan, findings: rows, scopesWithoutEnvFiles };
}

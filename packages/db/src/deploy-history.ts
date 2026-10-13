import { endpointLabel, findingsDiff, type FindingCounts, type FindingKey, type FindingKind } from '@deployhealth/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client';
import { alerts, checks, deploys, endpoints, findings, projects, scans, type Deploy } from './schema';

// The project page's deploy history: what each deploy changed and whether an outage followed it.
// Owner-scoped like every other query (test/isolation.test.ts).

/** What a deploy's latest scan changed compared with the latest scan of the previous scanned deploy. */
export type DeployChange =
  | { kind: 'unscanned' }
  /** The project's first scanned deploy: nothing to compare with. */
  | { kind: 'first' }
  | { kind: 'diff'; introduced: FindingKey[]; fixed: FindingKey[] };

/** An outage (an alert's run of failed checks) that started after this deploy and before the next one. */
export interface DeployOutage {
  /** The first failed check of the alert's run; the alert's open time if those checks were pruned. */
  startedAt: Date;
  resolvedAt: Date | null;
  /** The endpoint's label (its name, else its host). */
  endpoint: string;
  /** Further outages that started in the same window. */
  more: number;
}

export interface DeployHistoryItem {
  deploy: Deploy;
  /** The deploy's latest scan's counts; null if it has none. */
  counts: FindingCounts | null;
  scanCount: number;
  change: DeployChange;
  outage: DeployOutage | null;
}

interface DeployRow {
  deploy: Deploy;
  scanId: string | null;
  counts: FindingCounts | null;
  scanCount: number;
}

/**
 * A project's deploys, newest first, each with what it changed and the outage that followed it.
 * Empty when the project isn't `ownerId`'s.
 */
export async function listDeployHistory(db: Db, ownerId: string, projectId: string, limit = 50): Promise<DeployHistoryItem[]> {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
  if (!project) return [];

  const rows = await deployRows(db, projectId, sql`true`, limit);
  if (rows.length === 0) return [];

  // The oldest row is compared with the latest scanned deploy before it, which may be off the page.
  const oldest = rows[rows.length - 1]!.deploy;
  const [before] = await deployRows(
    db,
    projectId,
    sql`(d.deployed_at, d.created_at) < (${oldest.deployedAt.toISOString()}::timestamptz, ${oldest.createdAt.toISOString()}::timestamptz)
        and exists (select 1 from ${scans} x where x.deploy_id = d.id)`,
    1,
  );

  const scanIds = [...rows, ...(before ? [before] : [])].flatMap((r) => (r.scanId ? [r.scanId] : []));
  const keysByScan = new Map<string, FindingKey[]>();
  if (scanIds.length > 0) {
    const keys = await db
      .selectDistinct({ scanId: findings.scanId, kind: findings.kind, varName: findings.varName })
      .from(findings)
      .where(inArray(findings.scanId, scanIds));
    for (const k of keys) {
      const list = keysByScan.get(k.scanId) ?? [];
      list.push({ kind: k.kind as FindingKind, var_name: k.varName });
      keysByScan.set(k.scanId, list);
    }
  }

  const outages = await outagesSince(db, projectId, oldest.deployedAt);

  return rows.map((row, i) => {
    let change: DeployChange;
    if (!row.scanId) change = { kind: 'unscanned' };
    else {
      const previous = rows.slice(i + 1).find((r) => r.scanId) ?? before;
      change = previous?.scanId
        ? { kind: 'diff', ...findingsDiff(keysByScan.get(previous.scanId) ?? [], keysByScan.get(row.scanId) ?? []) }
        : { kind: 'first' };
    }
    // The window runs from this deploy to the next (newer) one; the newest deploy's never closes.
    const from = row.deploy.deployedAt.getTime();
    const to = i > 0 ? rows[i - 1]!.deploy.deployedAt.getTime() : Infinity;
    const inWindow = outages.filter((o) => o.startedAt.getTime() >= from && o.startedAt.getTime() < to);
    const first = inWindow[0];
    return {
      deploy: row.deploy,
      counts: row.counts,
      scanCount: row.scanCount,
      change,
      outage: first ? { ...first, more: inWindow.length - 1 } : null,
    };
  });
}

async function deployRows(db: Db, projectId: string, where: ReturnType<typeof sql>, limit: number): Promise<DeployRow[]> {
  const result = await db.execute<{
    id: string;
    project_id: string;
    sha: string;
    branch: string;
    deployed_at: string;
    source: Deploy['source'];
    created_at: string;
    scan_id: string | null;
    missing_count: number | null;
    unused_count: number | null;
    mismatch_count: number | null;
    scan_count: number;
  }>(sql`
    select d.id, d.project_id, d.sha, d.branch, d.deployed_at, d.source, d.created_at,
           s.id as scan_id, s.missing_count, s.unused_count, s.mismatch_count,
           (select count(*)::int from ${scans} c where c.deploy_id = d.id) as scan_count
    from ${deploys} d
    left join lateral (
      select id, missing_count, unused_count, mismatch_count from ${scans}
      where deploy_id = d.id order by created_at desc limit 1
    ) s on true
    where d.project_id = ${projectId} and ${where}
    order by d.deployed_at desc, d.created_at desc
    limit ${limit}
  `);
  return result.rows.map((r) => ({
    deploy: {
      id: r.id,
      projectId: r.project_id,
      sha: r.sha,
      branch: r.branch,
      deployedAt: new Date(r.deployed_at),
      source: r.source,
      createdAt: new Date(r.created_at),
    },
    scanId: r.scan_id,
    counts: r.missing_count === null ? null : { missing: r.missing_count, unused: r.unused_count ?? 0, mismatch: r.mismatch_count ?? 0 },
    scanCount: r.scan_count,
  }));
}

/**
 * The project's alerts whose run of failed checks started at or after `since`, earliest first.
 * The start is the first failed check after the last ok check before the alert opened, the same
 * moment the alert's message measures from; the alert's open time once those checks are pruned.
 */
async function outagesSince(db: Db, projectId: string, since: Date): Promise<Array<Omit<DeployOutage, 'more'>>> {
  const result = await db.execute<{ started_at: string; resolved_at: string | null; url: string; name: string | null }>(sql`
    select o.started_at, o.resolved_at, o.url, o.name from (
      select a.resolved_at, e.url, e.name,
             coalesce((
               select min(f.checked_at) from ${checks} f
               where f.endpoint_id = a.endpoint_id and not f.ok and f.checked_at <= a.created_at
                 and f.checked_at > coalesce(
                   (select max(k.checked_at) from ${checks} k
                    where k.endpoint_id = a.endpoint_id and k.ok and k.checked_at <= a.created_at),
                   '-infinity'::timestamptz)
             ), a.created_at) as started_at
      from ${alerts} a
      join ${endpoints} e on e.id = a.endpoint_id
      where a.project_id = ${projectId} and a.created_at >= ${since.toISOString()}::timestamptz
    ) o
    where o.started_at >= ${since.toISOString()}::timestamptz
    order by o.started_at
  `);
  return result.rows.map((r) => ({
    startedAt: new Date(r.started_at),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    endpoint: endpointLabel({ url: r.url, name: r.name }),
  }));
}

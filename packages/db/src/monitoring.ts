import {
  alertOpenedMessage,
  alertResolvedMessage,
  decideAlert,
  DEPLOY_LINK_WINDOW_MINUTES,
  newMissingVars,
  type EndpointInterval,
  type EndpointMethod,
} from '@deployhealth/core';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import { alerts, checks, deploys, endpoints, findings, projects, scans, type Alert, type Check, type Endpoint } from './schema';

// ---------------------------------------------------------------------------------------------
// Endpoint CRUD (owner-scoped)
// ---------------------------------------------------------------------------------------------

export interface EndpointInput {
  url: string;
  method: EndpointMethod;
  intervalSeconds: EndpointInterval;
  expectedStatus: number;
  enabled: boolean;
}

/** Subquery: ids of the owner's projects. */
function ownedProjectIds(db: Db, ownerId: string) {
  return db.select({ id: projects.id }).from(projects).where(eq(projects.ownerId, ownerId));
}

export async function listEndpointsForOwner(db: Db, ownerId: string, projectId: string): Promise<Endpoint[]> {
  return db
    .select()
    .from(endpoints)
    .where(and(eq(endpoints.projectId, projectId), inArray(endpoints.projectId, ownedProjectIds(db, ownerId))))
    .orderBy(asc(endpoints.createdAt));
}

/** Null when the project isn't the owner's. The URL must already have passed the SSRF guard. */
export async function createEndpoint(db: Db, ownerId: string, projectId: string, input: EndpointInput): Promise<Endpoint | null> {
  const [owned] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
  if (!owned) return null;
  const [endpoint] = await db.insert(endpoints).values({ projectId, ...input }).returning();
  return endpoint!;
}

/** Edits take effect on the next worker run: the endpoint becomes due immediately. */
export async function updateEndpoint(db: Db, ownerId: string, endpointId: string, input: EndpointInput): Promise<Endpoint | null> {
  const [endpoint] = await db
    .update(endpoints)
    .set({ ...input, nextCheckAt: sql`now()` })
    .where(and(eq(endpoints.id, endpointId), inArray(endpoints.projectId, ownedProjectIds(db, ownerId))))
    .returning();
  return endpoint ?? null;
}

/** Deletes the endpoint with its checks and alerts. */
export async function deleteEndpoint(db: Db, ownerId: string, endpointId: string): Promise<boolean> {
  const deleted = await db
    .delete(endpoints)
    .where(and(eq(endpoints.id, endpointId), inArray(endpoints.projectId, ownedProjectIds(db, ownerId))))
    .returning({ id: endpoints.id });
  return deleted.length === 1;
}

// ---------------------------------------------------------------------------------------------
// Scheduling (worker)
// ---------------------------------------------------------------------------------------------

export interface DueEndpoint {
  id: string;
  projectId: string;
  url: string;
  method: EndpointMethod;
  intervalSeconds: number;
  expectedStatus: number;
}

/**
 * Claim up to `limit` enabled endpoints whose next_check_at has passed, and move their
 * next_check_at forward by their interval in the same statement. FOR UPDATE SKIP LOCKED means
 * concurrent workers never claim the same endpoint; if a worker dies mid-check, the endpoint is
 * simply checked again one interval later.
 */
export async function claimDueEndpoints(
  db: Db,
  { now = new Date(), limit = 100 }: { now?: Date; limit?: number } = {},
): Promise<DueEndpoint[]> {
  const result = await db.execute<{
    id: string;
    project_id: string;
    url: string;
    method: EndpointMethod;
    interval_seconds: number;
    expected_status: number;
  }>(sql`
    update ${endpoints} e
    set next_check_at = ${now.toISOString()}::timestamptz + make_interval(secs => e.interval_seconds)
    where e.id in (
      select id from ${endpoints}
      where enabled and next_check_at <= ${now.toISOString()}::timestamptz
      order by next_check_at
      limit ${limit}
      for update skip locked
    )
    returning e.id, e.project_id, e.url, e.method, e.interval_seconds, e.expected_status
  `);
  return result.rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    url: r.url,
    method: r.method,
    intervalSeconds: r.interval_seconds,
    expectedStatus: r.expected_status,
  }));
}

// ---------------------------------------------------------------------------------------------
// Recording checks and the alert lifecycle (worker)
// ---------------------------------------------------------------------------------------------

export interface CheckOutcome {
  checkedAt: Date;
  statusCode: number | null;
  latencyMs: number | null;
  ok: boolean;
  error: string | null;
}

export interface AlertEvent {
  type: 'opened' | 'resolved';
  alertId: string;
  projectId: string;
  projectName: string;
  webhookUrl: string | null;
  message: string;
}

export interface RecordCheckResult {
  consecutiveFailures: number;
  event: AlertEvent | null;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Store one check and apply the alert rule, atomically:
 * - ok resets consecutive_failures and resolves an open alert;
 * - a failure increments it; the second one in a row opens an alert if the endpoint has ever
 *   been ok. The alert links the most recent deploy in the 30 minutes before the first failure
 *   and lists the MISSING vars that deploy introduced.
 * The returned event is for the webhook, which the caller sends after the transaction commits.
 */
export async function recordCheck(db: Db, endpointId: string, outcome: CheckOutcome): Promise<RecordCheckResult> {
  return db.transaction(async (tx) => {
    await tx.insert(checks).values({ endpointId, ...outcome });

    const [endpoint] = await tx
      .update(endpoints)
      .set({ consecutiveFailures: outcome.ok ? 0 : sql`${endpoints.consecutiveFailures} + 1` })
      .where(eq(endpoints.id, endpointId))
      .returning({ projectId: endpoints.projectId, url: endpoints.url, consecutiveFailures: endpoints.consecutiveFailures });
    if (!endpoint) throw new Error(`endpoint ${endpointId} not found`);

    const [open] = await tx
      .select({ id: alerts.id, createdAt: alerts.createdAt })
      .from(alerts)
      .where(and(eq(alerts.endpointId, endpointId), isNull(alerts.resolvedAt)))
      .for('update');

    const hasOkHistory =
      outcome.ok ||
      (await tx.select({ id: checks.id }).from(checks).where(and(eq(checks.endpointId, endpointId), eq(checks.ok, true))).limit(1))
        .length > 0;

    const action = decideAlert({
      ok: outcome.ok,
      consecutiveFailures: endpoint.consecutiveFailures,
      hasOkHistory,
      hasOpenAlert: Boolean(open),
    });
    if (action === 'none') return { consecutiveFailures: endpoint.consecutiveFailures, event: null };

    const [project] = await tx
      .select({ name: projects.name, webhookUrl: projects.alertWebhookUrl })
      .from(projects)
      .where(eq(projects.id, endpoint.projectId));
    const base = { projectId: endpoint.projectId, projectName: project!.name, webhookUrl: project!.webhookUrl };

    if (action === 'resolve') {
      await tx.update(alerts).set({ resolvedAt: outcome.checkedAt }).where(eq(alerts.id, open!.id));
      const message = alertResolvedMessage({ endpointUrl: endpoint.url, openedAt: open!.createdAt, resolvedAt: outcome.checkedAt });
      return { consecutiveFailures: 0, event: { type: 'resolved', alertId: open!.id, ...base, message } };
    }

    const firstFailureAt = await firstFailureOfStreak(tx, endpointId);
    const link = await linkDeploy(tx, endpoint.projectId, firstFailureAt);
    const message = alertOpenedMessage({
      endpointUrl: endpoint.url,
      firstFailureAt,
      deploy: link?.deploy ?? null,
      newMissing: link?.newMissing ?? [],
    });
    const [alert] = await tx
      .insert(alerts)
      .values({
        projectId: endpoint.projectId,
        endpointId,
        kind: 'endpoint_down',
        message,
        createdAt: outcome.checkedAt,
        relatedDeployId: link?.deploy.id ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: alerts.id });
    if (!alert) return { consecutiveFailures: endpoint.consecutiveFailures, event: null };
    return { consecutiveFailures: endpoint.consecutiveFailures, event: { type: 'opened', alertId: alert.id, ...base, message } };
  });
}

/** The first failed check after the endpoint's last ok check. */
async function firstFailureOfStreak(tx: Tx, endpointId: string): Promise<Date> {
  const result = await tx.execute<{ first: string }>(sql`
    select min(checked_at) as first from ${checks}
    where endpoint_id = ${endpointId} and not ok
      and checked_at > coalesce(
        (select max(checked_at) from ${checks} where endpoint_id = ${endpointId} and ok),
        '-infinity'::timestamptz
      )
  `);
  return new Date(result.rows[0]!.first);
}

interface DeployLink {
  deploy: { id: string; sha: string; deployedAt: Date };
  newMissing: string[];
}

/**
 * The project's most recent deploy in the window before `firstFailureAt`, and the MISSING vars
 * its latest scan has that the previous scanned deploy's latest scan didn't.
 */
async function linkDeploy(tx: Tx, projectId: string, firstFailureAt: Date): Promise<DeployLink | null> {
  const windowStart = new Date(firstFailureAt.getTime() - DEPLOY_LINK_WINDOW_MINUTES * 60_000);
  const [deploy] = await tx
    .select({ id: deploys.id, sha: deploys.sha, deployedAt: deploys.deployedAt })
    .from(deploys)
    .where(
      and(
        eq(deploys.projectId, projectId),
        sql`${deploys.deployedAt} <= ${firstFailureAt.toISOString()}::timestamptz`,
        sql`${deploys.deployedAt} >= ${windowStart.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(desc(deploys.deployedAt))
    .limit(1);
  if (!deploy) return null;

  const current = await latestScanFindings(tx, deploy.id);
  const [previous] = await tx
    .select({ id: deploys.id })
    .from(deploys)
    .where(
      and(
        eq(deploys.projectId, projectId),
        lt(deploys.deployedAt, deploy.deployedAt),
        sql`exists (select 1 from ${scans} where ${scans.deployId} = ${deploys.id})`,
      ),
    )
    .orderBy(desc(deploys.deployedAt))
    .limit(1);
  const before = previous ? await latestScanFindings(tx, previous.id) : null;

  return { deploy, newMissing: newMissingVars(current, before) };
}

async function latestScanFindings(tx: Tx, deployId: string) {
  const [scan] = await tx
    .select({ id: scans.id })
    .from(scans)
    .where(eq(scans.deployId, deployId))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  if (!scan) return [];
  return tx
    .select({ kind: findings.kind, var_name: findings.varName })
    .from(findings)
    .where(eq(findings.scanId, scan.id));
}

/** Delete checks older than `olderThan`. Returns how many were removed. */
export async function pruneChecks(db: Db, olderThan: Date): Promise<number> {
  const deleted = await db.delete(checks).where(lt(checks.checkedAt, olderThan)).returning({ id: checks.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------------------------
// Read models for the project page (owner-scoped)
// ---------------------------------------------------------------------------------------------

export type EndpointStatus = 'up' | 'failing' | 'down' | 'paused' | 'pending';

export interface EndpointMonitoring {
  endpoint: Endpoint;
  status: EndpointStatus;
  /** Share of ok checks, 0–1; null when there were no checks in the window. */
  uptime24h: number | null;
  uptime7d: number | null;
  /** Hourly p50/p95 latency (ms) of ok checks over the last 24 hours. */
  latency: Array<{ hour: Date; p50: number; p95: number }>;
  /** Newest first. */
  recent: Check[];
  openAlert: Alert | null;
}

export async function getProjectMonitoring(
  db: Db,
  ownerId: string,
  projectId: string,
  now = new Date(),
): Promise<EndpointMonitoring[]> {
  const list = await listEndpointsForOwner(db, ownerId, projectId);
  return Promise.all(list.map((endpoint) => endpointMonitoring(db, endpoint, now)));
}

async function endpointMonitoring(db: Db, endpoint: Endpoint, now: Date): Promise<EndpointMonitoring> {
  const day = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const week = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();

  const [uptime, latency, recent, openAlerts] = await Promise.all([
    db.execute<{ total24: number; ok24: number; total7: number; ok7: number }>(sql`
      select count(*) filter (where checked_at >= ${day}::timestamptz)::int as total24,
             count(*) filter (where checked_at >= ${day}::timestamptz and ok)::int as ok24,
             count(*)::int as total7,
             count(*) filter (where ok)::int as ok7
      from ${checks} where endpoint_id = ${endpoint.id} and checked_at >= ${week}::timestamptz
    `),
    db.execute<{ hour: string; p50: number; p95: number }>(sql`
      select date_trunc('hour', checked_at) as hour,
             percentile_cont(0.5) within group (order by latency_ms) as p50,
             percentile_cont(0.95) within group (order by latency_ms) as p95
      from ${checks}
      where endpoint_id = ${endpoint.id} and ok and latency_ms is not null and checked_at >= ${day}::timestamptz
      group by 1 order by 1
    `),
    db.select().from(checks).where(eq(checks.endpointId, endpoint.id)).orderBy(desc(checks.checkedAt)).limit(20),
    db
      .select()
      .from(alerts)
      .where(and(eq(alerts.endpointId, endpoint.id), isNull(alerts.resolvedAt))),
  ]);

  const u = uptime.rows[0]!;
  const openAlert = openAlerts[0] ?? null;
  const latest = recent[0];
  const status: EndpointStatus = !endpoint.enabled
    ? 'paused'
    : openAlert
      ? 'down'
      : !latest
        ? 'pending'
        : latest.ok
          ? 'up'
          : 'failing';

  return {
    endpoint,
    status,
    uptime24h: u.total24 ? u.ok24 / u.total24 : null,
    uptime7d: u.total7 ? u.ok7 / u.total7 : null,
    latency: latency.rows.map((r) => ({ hour: new Date(r.hour), p50: Math.round(Number(r.p50)), p95: Math.round(Number(r.p95)) })),
    recent,
    openAlert,
  };
}

export interface OpenAlertView {
  alert: Alert;
  endpointUrl: string | null;
  deploy: { id: string; sha: string } | null;
}

/** Open alerts of one of the owner's projects, newest first (for the banner). */
export async function listOpenAlerts(db: Db, ownerId: string, projectId: string): Promise<OpenAlertView[]> {
  const rows = await db
    .select({ alert: alerts, endpointUrl: endpoints.url, deployId: deploys.id, deploySha: deploys.sha })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .leftJoin(endpoints, eq(endpoints.id, alerts.endpointId))
    .leftJoin(deploys, eq(deploys.id, alerts.relatedDeployId))
    .where(and(eq(alerts.projectId, projectId), eq(projects.ownerId, ownerId), isNull(alerts.resolvedAt)))
    .orderBy(desc(alerts.createdAt));
  return rows.map((r) => ({
    alert: r.alert,
    endpointUrl: r.endpointUrl,
    deploy: r.deployId && r.deploySha ? { id: r.deployId, sha: r.deploySha } : null,
  }));
}

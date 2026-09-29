import {
  alertOpenedMessage,
  alertResolvedMessage,
  decideAlert,
  DEPLOY_LINK_WINDOW_MINUTES,
  newMissingVars,
  type EndpointInterval,
  type EndpointMethod,
} from '@deployhealth/core';
import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { alerts, checks, deploys, endpointDailyStats, endpoints, findings, projects, scans, type Alert, type Check, type Endpoint } from './schema';

// ---------------------------------------------------------------------------------------------
// Endpoint CRUD (owner-scoped)
// ---------------------------------------------------------------------------------------------

export interface EndpointInput {
  url: string;
  /** Display name; null clears it. Omitted on update keeps the current one. */
  name?: string | null;
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
      .returning({
        projectId: endpoints.projectId,
        url: endpoints.url,
        name: endpoints.name,
        consecutiveFailures: endpoints.consecutiveFailures,
      });
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
      const message = alertResolvedMessage({ endpoint, openedAt: open!.createdAt, resolvedAt: outcome.checkedAt });
      return { consecutiveFailures: 0, event: { type: 'resolved', alertId: open!.id, ...base, message } };
    }

    const firstFailureAt = await firstFailureOfStreak(tx, endpointId);
    const link = await linkDeploy(tx, endpoint.projectId, firstFailureAt);
    const message = alertOpenedMessage({
      endpoint,
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

/**
 * SQL subquery: when the endpoint's current run of failed checks began, i.e. its first failed
 * check after its last ok one. Null when the latest check was ok or there are no checks. Pass an
 * id, or a column reference such as sql`e.id` for use inside a larger query.
 */
export function failingSinceSql(endpointId: string | SQL): SQL {
  return sql`(
    select min(f.checked_at) from ${checks} f
    where f.endpoint_id = ${endpointId} and not f.ok
      and f.checked_at > coalesce(
        (select max(o.checked_at) from ${checks} o where o.endpoint_id = ${endpointId} and o.ok),
        '-infinity'::timestamptz
      )
  )`;
}

async function firstFailureOfStreak(tx: Tx, endpointId: string): Promise<Date> {
  const result = await tx.execute<{ since: string }>(sql`select ${failingSinceSql(endpointId)} as since`);
  return new Date(result.rows[0]!.since);
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
/**
 * Roll raw checks up into endpoint_daily_stats: one row per endpoint per complete UTC day before
 * `before` (normally today's midnight UTC). Recomputes every such day that still has raw checks,
 * so it's idempotent and picks up checks recorded just after midnight. Returns the rows written.
 */
export async function rollupChecks(db: Db, before: Date): Promise<number> {
  const cutoff = startOfUtcDay(before).toISOString();
  const result = await db.execute(sql`
    insert into ${endpointDailyStats} (endpoint_id, day, checks, ok)
    select endpoint_id, (checked_at at time zone 'UTC')::date, count(*)::int, (count(*) filter (where ok))::int
    from ${checks}
    where checked_at < ${cutoff}::timestamptz
    group by 1, 2
    on conflict (endpoint_id, day) do update set checks = excluded.checks, ok = excluded.ok
  `);
  return result.rowCount ?? 0;
}

export async function pruneChecks(db: Db, olderThan: Date): Promise<number> {
  const deleted = await db.delete(checks).where(lt(checks.checkedAt, olderThan)).returning({ id: checks.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------------------------
// Uptime over a range (handoff and reports)
// ---------------------------------------------------------------------------------------------

export interface CheckTally {
  checks: number;
  ok: number;
}

/** ok / checks, or null with no checks. */
export function uptimeRatio(tally: CheckTally): number | null {
  return tally.checks ? tally.ok / tally.checks : null;
}

/** Midnight UTC of `date`'s day. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Checks and ok checks for one endpoint in [from, to). Complete UTC days that have been rolled
 * up into endpoint_daily_stats count from there (they outlive the 30-day raw retention); every
 * other day counts its raw checks. Pass day-aligned bounds for exact results on old ranges.
 */
export async function uptimeBetween(db: Db, endpointId: string, from: Date, to: Date): Promise<CheckTally> {
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const result = await db.execute<{ checks: number; ok: number }>(sql`
    select coalesce(sum(x.checks), 0)::int as checks, coalesce(sum(x.ok), 0)::int as ok from (
      select d.checks, d.ok from ${endpointDailyStats} d
      where d.endpoint_id = ${endpointId}
        and (d.day::timestamp at time zone 'UTC') >= ${fromIso}::timestamptz
        and (d.day::timestamp at time zone 'UTC') < ${toIso}::timestamptz
      union all
      select count(*)::int, (count(*) filter (where c.ok))::int from ${checks} c
      where c.endpoint_id = ${endpointId}
        and c.checked_at >= ${fromIso}::timestamptz and c.checked_at < ${toIso}::timestamptz
        and not exists (
          select 1 from ${endpointDailyStats} d
          where d.endpoint_id = c.endpoint_id
            and d.day = (c.checked_at at time zone 'UTC')::date
            and (d.day::timestamp at time zone 'UTC') >= ${fromIso}::timestamptz
        )
    ) x
  `);
  const row = result.rows[0]!;
  return { checks: Number(row.checks), ok: Number(row.ok) };
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
  /** First failed check of the current run while the status is down or failing; null otherwise. */
  failingSince: Date | null;
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

  const [uptime, latency, recent, openAlerts, failing] = await Promise.all([
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
    db.execute<{ since: string | null }>(sql`select ${failingSinceSql(endpoint.id)} as since`),
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
  const since = failing.rows[0]?.since;

  return {
    endpoint,
    status,
    uptime24h: u.total24 ? u.ok24 / u.total24 : null,
    uptime7d: u.total7 ? u.ok7 / u.total7 : null,
    latency: latency.rows.map((r) => ({ hour: new Date(r.hour), p50: Math.round(Number(r.p50)), p95: Math.round(Number(r.p95)) })),
    recent,
    openAlert,
    failingSince: (status === 'down' || status === 'failing') && since ? new Date(since) : null,
  };
}

export interface OpenAlertView {
  alert: Alert;
  endpointUrl: string | null;
  endpointName: string | null;
  deploy: { id: string; sha: string } | null;
}

/** Open alerts of one of the owner's projects, newest first (for the banner). */
export async function listOpenAlerts(db: Db, ownerId: string, projectId: string): Promise<OpenAlertView[]> {
  const rows = await db
    .select({ alert: alerts, endpointUrl: endpoints.url, endpointName: endpoints.name, deployId: deploys.id, deploySha: deploys.sha })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .leftJoin(endpoints, eq(endpoints.id, alerts.endpointId))
    .leftJoin(deploys, eq(deploys.id, alerts.relatedDeployId))
    .where(and(eq(alerts.projectId, projectId), eq(projects.ownerId, ownerId), isNull(alerts.resolvedAt)))
    .orderBy(desc(alerts.createdAt));
  return rows.map((r) => ({
    alert: r.alert,
    endpointUrl: r.endpointUrl,
    endpointName: r.endpointName,
    deploy: r.deployId && r.deploySha ? { id: r.deployId, sha: r.deploySha } : null,
  }));
}

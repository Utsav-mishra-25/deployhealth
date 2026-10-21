import {
  alertOpenedMessage,
  alertPausedMessage,
  alertResolvedMessage,
  CLAIM_WINDOW_MS,
  decideAlert,
  DEPLOY_LINK_WINDOW_MINUTES,
  HOST_CHECK_SPACING_MS,
  LimitExceededError,
  MAX_CHECKS_PER_HOST_PER_CLAIM,
  MAX_CLAIM_PER_OWNER,
  MAX_ENDPOINTS_PER_PROJECT,
  MAX_ENDPOINTS_PER_USER,
  type EndpointInterval,
  type EndpointMethod,
} from '@deployhealth/core';
import { and, asc, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { deployConfigChange, type DeployConfigChange } from './deploy-config';
import {
  alerts,
  checkHosts,
  checks,
  deploys,
  endpointDailyStats,
  endpoints,
  projects,
  users,
  type Alert,
  type Check,
  type Endpoint,
} from './schema';

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

/**
 * Null when the project isn't the owner's. The URL must already have passed the SSRF guard.
 * Throws LimitExceededError at 100 endpoints in the project or 500 across the owner's projects.
 */
export async function createEndpoint(db: Db, ownerId: string, projectId: string, input: EndpointInput): Promise<Endpoint | null> {
  return db.transaction(async (tx) => {
    const [owned] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.ownerId, ownerId)));
    if (!owned) return null;

    // Lock the owner's row: concurrent creates for one user queue here, so the counts can't race.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update');
    const [counts] = await tx
      .select({
        inProject: sql<number>`count(*) filter (where ${endpoints.projectId} = ${projectId})::int`,
        forUser: sql<number>`count(*)::int`,
      })
      .from(endpoints)
      .innerJoin(projects, eq(projects.id, endpoints.projectId))
      .where(eq(projects.ownerId, ownerId));
    if (counts!.inProject >= MAX_ENDPOINTS_PER_PROJECT) {
      throw new LimitExceededError('endpointsPerProject', `A project can have at most ${MAX_ENDPOINTS_PER_PROJECT} endpoints.`);
    }
    if (counts!.forUser >= MAX_ENDPOINTS_PER_USER) {
      throw new LimitExceededError('endpointsPerUser', `An account can have at most ${MAX_ENDPOINTS_PER_USER} endpoints across all projects.`);
    }

    const [endpoint] = await tx.insert(endpoints).values({ projectId, ...input }).returning();
    return endpoint!;
  });
}

export interface UpdateEndpointResult {
  endpoint: Endpoint;
  /** The 'resolved' event when this edit paused an endpoint with an open alert; the caller queues its webhook. */
  event: AlertEvent | null;
}

/**
 * Edits take effect on the next worker run: the endpoint becomes due immediately. Changing
 * `enabled` either way resets both consecutive counters, so re-enabling starts fresh. Pausing
 * (enabled true → false) resolves an open alert in the same transaction, at `now`, with
 * resolution 'paused': a paused endpoint isn't counted as down until month end.
 * Null when the endpoint isn't the owner's.
 */
export async function updateEndpoint(
  db: Db,
  ownerId: string,
  endpointId: string,
  input: EndpointInput,
  { now = new Date() }: { now?: Date } = {},
): Promise<UpdateEndpointResult | null> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ enabled: endpoints.enabled })
      .from(endpoints)
      .where(and(eq(endpoints.id, endpointId), inArray(endpoints.projectId, ownedProjectIds(db, ownerId))))
      .for('update');
    if (!current) return null;

    const enabledChanged = current.enabled !== input.enabled;
    const [endpoint] = await tx
      .update(endpoints)
      .set({ ...input, nextCheckAt: sql`now()`, ...(enabledChanged ? { consecutiveFailures: 0, consecutiveOk: 0 } : {}) })
      .where(eq(endpoints.id, endpointId))
      .returning();
    if (!(current.enabled && !input.enabled)) return { endpoint: endpoint!, event: null };

    const [paused] = await tx
      .update(alerts)
      .set({ resolvedAt: now, resolution: 'paused' })
      .where(and(eq(alerts.endpointId, endpointId), isNull(alerts.resolvedAt)))
      .returning({ id: alerts.id, createdAt: alerts.createdAt });
    if (!paused) return { endpoint: endpoint!, event: null };

    const [project] = await tx
      .select({ name: projects.name, webhookUrl: projects.alertWebhookUrl })
      .from(projects)
      .where(eq(projects.id, endpoint!.projectId));
    const message = alertPausedMessage({ endpoint: endpoint!, openedAt: paused.createdAt, pausedAt: now });
    return {
      endpoint: endpoint!,
      event: {
        type: 'resolved',
        alertId: paused.id,
        projectId: endpoint!.projectId,
        projectName: project!.name,
        webhookUrl: project!.webhookUrl,
        message,
      },
    };
  });
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
  hostname: string;
  method: EndpointMethod;
  intervalSeconds: number;
  expectedStatus: number;
  /** When the worker may start this check: checks of one hostname start HOST_CHECK_SPACING_MS apart. */
  runAt: Date;
}

// One claim hands out check start times up to CLAIM_WINDOW_MS after `now` (in core, so the endpoint
// form and /security can state it); re-exported for existing imports.
export { CLAIM_WINDOW_MS };

/** pg_advisory_xact_lock key: one claimer at a time, so host slots are read and saved as a unit. */
const CLAIM_LOCK_KEY = 4_815_162_342;

/** The URL's hostname, lowercased, in SQL (stored URLs are normalized and never carry credentials). */
const hostnameOf = (url: SQL) => sql`coalesce(lower(substring(${url} from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?(\\[[^]]*\\]|[^/?#:]*)')), '')`;

/**
 * Start times for due checks, given in priority order, so no hostname is checked more than once
 * per `spacingMs`, across all users. A host's first slot is the later of `now` and the slot its
 * previous claim reserved, rounded up to the job's wave grid (`now + k·spacingMs`); each further
 * check of that host takes the next slot. Slots at or past `windowMs` aren't handed out: those
 * endpoints stay due and go first next time. Pure; `claimDueEndpoints` applies it.
 */
export function assignHostSlots<T extends { hostname: string }>(
  due: readonly T[],
  reserved: ReadonlyMap<string, Date>,
  now: Date,
  { spacingMs = HOST_CHECK_SPACING_MS, windowMs = CLAIM_WINDOW_MS }: { spacingMs?: number; windowMs?: number } = {},
): { assigned: Array<T & { runAt: Date }>; nextFree: Map<string, Date> } {
  const nextOffset = new Map<string, number>();
  const assigned: Array<T & { runAt: Date }> = [];
  const nextFree = new Map<string, Date>();
  for (const endpoint of due) {
    let offset = nextOffset.get(endpoint.hostname);
    if (offset === undefined) {
      const free = (reserved.get(endpoint.hostname)?.getTime() ?? 0) - now.getTime();
      offset = Math.max(0, Math.ceil(free / spacingMs) * spacingMs);
    }
    if (offset < windowMs) {
      assigned.push({ ...endpoint, runAt: new Date(now.getTime() + offset) });
      offset += spacingMs;
      nextFree.set(endpoint.hostname, new Date(now.getTime() + offset));
    }
    nextOffset.set(endpoint.hostname, offset);
  }
  return { assigned, nextFree };
}

export interface ClaimResult {
  endpoints: DueEndpoint[];
  /**
   * Hostnames whose due endpoints this claim couldn't all take because of per-host spacing: more
   * than MAX_CHECKS_PER_HOST_PER_CLAIM were due, or the host's slots in the window ran out. Their
   * leftovers wait by design and aren't a backlog (countDueEndpoints counts them apart).
   */
  hostsAtCap: string[];
}

/**
 * Claim due endpoints (enabled, next_check_at passed), give each a start time with
 * `assignHostSlots`, and move each claimed endpoint's next_check_at one interval past its start.
 * At most MAX_CHECKS_PER_HOST_PER_CLAIM (CLAIM_WINDOW_MS / HOST_CHECK_SPACING_MS) endpoints per hostname are considered per claim,
 * so one busy host can't crowd out the others, and at most MAX_CLAIM_PER_OWNER per owner, so one
 * account can't fill a run. Owners take turns: each owner's oldest due endpoint, then each
 * owner's second, and so on (oldest first within a turn). Claims run one at a time (advisory
 * lock), so two workers never claim the same endpoint or share a host slot. If a worker dies
 * mid-check, the endpoint is simply checked again one interval later. Also returns the hostnames
 * that hit the per-host cap (`hostsAtCap`).
 */
export async function claimDueEndpoints(
  db: Db,
  { now = new Date(), limit = 500, perOwner = MAX_CLAIM_PER_OWNER }: { now?: Date; limit?: number; perOwner?: number } = {},
): Promise<ClaimResult> {
  const perHost = MAX_CHECKS_PER_HOST_PER_CLAIM;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CLAIM_LOCK_KEY})`);
    const due = await tx.execute<{
      id: string;
      project_id: string;
      url: string;
      hostname: string;
      method: EndpointMethod;
      interval_seconds: number;
      expected_status: number;
      host_due: number;
    }>(sql`
      select id, project_id, url, hostname, method, interval_seconds, expected_status, host_due
      from (
        select h.*, row_number() over (partition by h.owner_id order by h.next_check_at, h.id) as owner_turn
        from (
          select e.id, e.project_id, e.url, e.method, e.interval_seconds, e.expected_status, e.next_check_at, p.owner_id,
                 ${hostnameOf(sql`e.url`)} as hostname,
                 row_number() over (partition by ${hostnameOf(sql`e.url`)} order by e.next_check_at, e.id) as n,
                 count(*) over (partition by ${hostnameOf(sql`e.url`)})::int as host_due
          from ${endpoints} e
          join ${projects} p on p.id = e.project_id
          where e.enabled and e.next_check_at <= ${now.toISOString()}::timestamptz
        ) h
        where h.n <= ${perHost}
      ) d
      where owner_turn <= ${perOwner}
      order by owner_turn, next_check_at, id
      limit ${limit}
    `);
    if (due.rows.length === 0) return { endpoints: [], hostsAtCap: [] };

    const hostnames = [...new Set(due.rows.map((r) => r.hostname))];
    const reserved = await tx.select().from(checkHosts).where(inArray(checkHosts.hostname, hostnames));
    const { assigned, nextFree } = assignHostSlots(
      due.rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        url: r.url,
        hostname: r.hostname,
        method: r.method,
        intervalSeconds: r.interval_seconds,
        expectedStatus: r.expected_status,
      })),
      new Map(reserved.map((h) => [h.hostname, h.nextSlotAt])),
      now,
    );
    // At the cap: more due than one claim may take, or fewer slots left in the window than rows.
    const taken = new Map<string, number>();
    for (const a of assigned) taken.set(a.hostname, (taken.get(a.hostname) ?? 0) + 1);
    const offered = new Map<string, number>();
    for (const r of due.rows) offered.set(r.hostname, (offered.get(r.hostname) ?? 0) + 1);
    const hostDue = new Map(due.rows.map((r) => [r.hostname, Number(r.host_due)]));
    const hostsAtCap = hostnames.filter((host) => hostDue.get(host)! > perHost || (taken.get(host) ?? 0) < offered.get(host)!);
    if (assigned.length === 0) return { endpoints: [], hostsAtCap };

    const starts = sql.join(
      assigned.map((a) => sql`(${a.id}::uuid, ${a.runAt.toISOString()}::timestamptz)`),
      sql`, `,
    );
    await tx.execute(sql`
      update ${endpoints} e
      set next_check_at = v.run_at + make_interval(secs => e.interval_seconds)
      from (values ${starts}) as v(id, run_at)
      where e.id = v.id
    `);
    await tx
      .insert(checkHosts)
      .values([...nextFree].map(([hostname, nextSlotAt]) => ({ hostname, nextSlotAt })))
      .onConflictDoUpdate({ target: checkHosts.hostname, set: { nextSlotAt: sql`excluded.next_slot_at` } });
    return { endpoints: assigned, hostsAtCap };
  });
}

export interface DueCount {
  /** Enabled endpoints still due. */
  due: number;
  /** Of those, the ones on `hostsAtCap`: waiting on per-host spacing, by design. */
  waitingOnHost: number;
}

/**
 * Enabled endpoints still due at `now` (worker): run right after a claim, these are the ones it
 * left for next time (host spacing, the per-owner cap or the limit), and how many of them are on
 * the hostnames that claim left at the per-host cap. Counts, never ids or URLs.
 */
export async function countDueEndpoints(db: Db, { now = new Date(), hostsAtCap = [] }: { now?: Date; hostsAtCap?: readonly string[] } = {}): Promise<DueCount> {
  const onHosts = hostsAtCap.length
    ? sql`${hostnameOf(sql`${endpoints.url}`)} in (${sql.join(
        hostsAtCap.map((h) => sql`${h}`),
        sql`, `,
      )})`
    : sql`false`;
  const [row] = await db
    .select({ due: sql<number>`count(*)::int`, waitingOnHost: sql<number>`(count(*) filter (where ${onHosts}))::int` })
    .from(endpoints)
    .where(and(eq(endpoints.enabled, true), sql`${endpoints.nextCheckAt} <= ${now.toISOString()}::timestamptz`));
  return { due: Number(row!.due), waitingOnHost: Number(row!.waitingOnHost) };
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
 * - ok resets consecutive_failures and increments consecutive_ok; the second ok in a row
 *   (ALERT_RECOVERY_THRESHOLD) resolves an open alert, so a flapping host stays one incident;
 * - a failure increments consecutive_failures and resets consecutive_ok; the second one in a row
 *   opens an alert if the endpoint has ever been ok. The alert links the most recent deploy in the 30 minutes before the first failure
 *   and lists the MISSING vars that deploy introduced.
 * The returned event is for the webhook, which the caller sends after the transaction commits.
 */
export async function recordCheck(db: Db, endpointId: string, outcome: CheckOutcome): Promise<RecordCheckResult> {
  return db.transaction(async (tx) => {
    await tx.insert(checks).values({ endpointId, ...outcome });

    const [endpoint] = await tx
      .update(endpoints)
      .set(
        outcome.ok
          ? { consecutiveFailures: 0, consecutiveOk: sql`${endpoints.consecutiveOk} + 1` }
          : { consecutiveFailures: sql`${endpoints.consecutiveFailures} + 1`, consecutiveOk: 0 },
      )
      .where(eq(endpoints.id, endpointId))
      .returning({
        projectId: endpoints.projectId,
        url: endpoints.url,
        name: endpoints.name,
        enabled: endpoints.enabled,
        consecutiveFailures: endpoints.consecutiveFailures,
        consecutiveOk: endpoints.consecutiveOk,
      });
    if (!endpoint) throw new Error(`endpoint ${endpointId} not found`);
    // A check claimed before a pause can land after it: keep the check, take no alert action.
    if (!endpoint.enabled) return { consecutiveFailures: endpoint.consecutiveFailures, event: null };

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
      consecutiveOk: endpoint.consecutiveOk,
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
      await tx.update(alerts).set({ resolvedAt: outcome.checkedAt, resolution: 'recovered' }).where(eq(alerts.id, open!.id));
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
      newUndeclared: link?.newUndeclared ?? [],
      newDeclared: link?.newDeclared ?? null,
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
 * Where to send a queued alert webhook (worker): the project's name and current webhook URL, or
 * null when the project is gone. By project id, like recordCheck: the web app scoped the event
 * to its owner when it queued it.
 */
export async function alertWebhookTarget(db: Db, projectId: string): Promise<{ projectName: string; webhookUrl: string | null } | null> {
  const [project] = await db
    .select({ projectName: projects.name, webhookUrl: projects.alertWebhookUrl })
    .from(projects)
    .where(eq(projects.id, projectId));
  return project ?? null;
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

interface DeployLink extends DeployConfigChange {
  deploy: { id: string; sha: string; deployedAt: Date };
}

/**
 * The project's most recent deploy in the window before `firstFailureAt`, and what it added to the
 * config (deployConfigChange).
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
  return { deploy, ...(await deployConfigChange(tx, projectId, deploy)) };
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
  // Host slots that passed long ago mean "free now", same as no row.
  await db.delete(checkHosts).where(lt(checkHosts.nextSlotAt, olderThan));
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
  /** Failed checks in the last 24 hours. */
  failures24h: number;
  /** Hourly p50/p95 latency (ms) of ok checks over the last 24 hours. */
  latency: Array<{ hour: Date; p50: number; p95: number }>;
  /** Newest first. */
  recent: Check[];
  openAlert: Alert | null;
  /**
   * What "Down for 21m" / "Failing for 1m" counts from: the open alert's created_at while down
   * (the number the resolved message uses, so it stays through the ok checks before recovery),
   * the first failed check of the current run while failing; null otherwise.
   */
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
    db.execute<{ total24: number; ok24: number; failed24: number; total7: number; ok7: number }>(sql`
      select count(*) filter (where checked_at >= ${day}::timestamptz)::int as total24,
             count(*) filter (where checked_at >= ${day}::timestamptz and ok)::int as ok24,
             count(*) filter (where checked_at >= ${day}::timestamptz and not ok)::int as failed24,
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
    failures24h: Number(u.failed24),
    latency: latency.rows.map((r) => ({ hour: new Date(r.hour), p50: Math.round(Number(r.p50)), p95: Math.round(Number(r.p95)) })),
    recent,
    openAlert,
    failingSince: status === 'down' ? openAlert!.createdAt : status === 'failing' && since ? new Date(since) : null,
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

export interface AlertHistoryItem {
  id: string;
  kind: string;
  /** The message as it was sent when the alert opened. */
  message: string;
  openedAt: Date;
  resolvedAt: Date | null;
  /** null while open; 'recovered' (ok checks; alerts resolved before 0010 too) or 'paused'. */
  resolution: 'recovered' | 'paused' | null;
  /** The endpoint's fields for endpointLabel(); null for project-level alerts. */
  endpoint: { url: string; name: string | null } | null;
  /** The deploy the alert linked; null when none (or deleted since). */
  deploy: { id: string; sha: string } | null;
}

/** Most alerts listAlerts returns in one call. */
export const MAX_ALERT_HISTORY = 200;

/** One of the owner's projects' alerts, open and resolved, newest first. */
export async function listAlerts(
  db: Db,
  ownerId: string,
  projectId: string,
  { limit = 50 }: { limit?: number } = {},
): Promise<AlertHistoryItem[]> {
  const rows = await db
    .select({ alert: alerts, endpointUrl: endpoints.url, endpointName: endpoints.name, deployId: deploys.id, deploySha: deploys.sha })
    .from(alerts)
    .innerJoin(projects, eq(projects.id, alerts.projectId))
    .leftJoin(endpoints, eq(endpoints.id, alerts.endpointId))
    .leftJoin(deploys, eq(deploys.id, alerts.relatedDeployId))
    .where(and(eq(alerts.projectId, projectId), eq(projects.ownerId, ownerId)))
    .orderBy(desc(alerts.createdAt), desc(alerts.id))
    .limit(Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), MAX_ALERT_HISTORY) : 50);
  return rows.map(({ alert, endpointUrl, endpointName, deployId, deploySha }) => ({
    id: alert.id,
    kind: alert.kind,
    message: alert.message,
    openedAt: alert.createdAt,
    resolvedAt: alert.resolvedAt,
    resolution: alert.resolvedAt ? (alert.resolution ?? 'recovered') : null,
    endpoint: endpointUrl ? { url: endpointUrl, name: endpointName } : null,
    deploy: deployId && deploySha ? { id: deployId, sha: deploySha } : null,
  }));
}

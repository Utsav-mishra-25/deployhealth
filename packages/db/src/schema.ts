import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const deploySource = pgEnum('deploy_source', ['ingest', 'manual']);
export const findingKind = pgEnum('finding_kind', ['missing', 'unused', 'mismatch']);

/** GitHub users who have signed in. Upserted by `github_id` on every sign-in. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  login: text('login').notNull(),
  name: text('name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** A freelancer's client. Deleting one unassigns its projects (projects.client_id → null). */
export const clients = pgTable(
  'clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** URL-friendly, unique per user, stable across renames. */
    slug: text('slug').notNull(),
    contactEmail: text('contact_email'),
    notes: text('notes'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('clients_user_slug_uq').on(t.userId, t.slug)],
);

export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** "owner/repo" */
    repoFullName: text('repo_full_name').notNull(),
    /** SHA-256 (hex) of the ingest bearer token. The token itself is never stored. */
    apiTokenHash: text('api_token_hash').notNull().unique(),
    /** Short, non-secret hint shown in the UI, e.g. "dh_…a1b2". */
    apiTokenHint: text('api_token_hint').notNull(),
    /** Optional grouping. Must belong to the same user (enforced in queries). */
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    /** Slack/Discord-compatible incoming webhook; receives {text} when alerts open and resolve. */
    alertWebhookUrl: text('alert_webhook_url'),
    /** "How to deploy" for the handoff export. Markdown, untrusted: rendered without raw HTML. */
    deployNotes: text('deploy_notes'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('projects_owner_name_uq').on(t.ownerId, t.name),
    index('projects_client_idx').on(t.clientId),
    check('projects_deploy_notes_length_check', sql`char_length(${t.deployNotes}) <= 20000`),
  ],
);

/** One row per commit per project. Re-ingesting the same sha adds a scan to the existing deploy. */
export const deploys = pgTable(
  'deploys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    branch: text('branch').notNull(),
    /** The ingest payload's `timestamp` (named to avoid the SQL type name). */
    deployedAt: ts('deployed_at').notNull(),
    source: deploySource('source').notNull().default('ingest'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('deploys_project_sha_uq').on(t.projectId, t.sha),
    index('deploys_project_time_idx').on(t.projectId, t.deployedAt.desc()),
  ],
);

export const scans = pgTable(
  'scans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deployId: uuid('deploy_id')
      .notNull()
      .references(() => deploys.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** Distinct variable names per kind, computed server-side from the findings. */
    missingCount: integer('missing_count').notNull(),
    unusedCount: integer('unused_count').notNull(),
    mismatchCount: integer('mismatch_count').notNull(),
  },
  (t) => [index('scans_deploy_time_idx').on(t.deployId, t.createdAt.desc())],
);

export const findings = pgTable(
  'findings',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    kind: findingKind('kind').notNull(),
    varName: text('var_name').notNull(),
    /** Where to look: the code file (missing) or the env file (unused, mismatch). */
    file: text('file'),
    line: integer('line'),
    /** null (missing) · the defining env file (unused) · the env file it is absent from (mismatch). */
    envFile: text('env_file'),
  },
  (t) => [index('findings_scan_kind_idx').on(t.scanId, t.kind)],
);

/**
 * Every variable a scan found referenced in code, per env scope, with the env files of that scope
 * that define it. Names only: the CLI never sends values. Empty `defined_in` means MISSING.
 */
export const scanVariables = pgTable(
  'scan_variables',
  {
    scanId: uuid('scan_id')
      .notNull()
      .references(() => scans.id, { onDelete: 'cascade' }),
    /** Directory that owns the env files, relative to the repo root; '' is the root. */
    scope: text('scope').notNull(),
    varName: text('var_name').notNull(),
    definedIn: text('defined_in').array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [primaryKey({ columns: [t.scanId, t.scope, t.varName] })],
);

/** URLs the worker checks. The scheduler claims rows whose next_check_at has passed. */
export const endpoints = pgTable(
  'endpoints',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** Optional display name ("Acme API"); alerts, badges and webhooks fall back to the host. */
    name: varchar('name', { length: 60 }),
    method: text('method', { enum: ['GET', 'HEAD'] })
      .notNull()
      .default('GET'),
    intervalSeconds: integer('interval_seconds').notNull().default(60),
    expectedStatus: integer('expected_status').notNull().default(200),
    enabled: boolean('enabled').notNull().default(true),
    /** New endpoints are due immediately. */
    nextCheckAt: ts('next_check_at').notNull().defaultNow(),
    /** Failed checks since the last ok one; drives the alert threshold. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('endpoints_project_idx').on(t.projectId),
    index('endpoints_due_idx')
      .on(t.nextCheckAt)
      .where(sql`${t.enabled}`),
    check('endpoints_method_check', sql`${t.method} in ('GET', 'HEAD')`),
    check('endpoints_interval_check', sql`${t.intervalSeconds} in (60, 300, 900)`),
    check('endpoints_expected_status_check', sql`${t.expectedStatus} between 100 and 599`),
    check('endpoints_name_check', sql`${t.name} is null or char_length(btrim(${t.name})) > 0`),
  ],
);

/** One row per uptime check. High volume, so a bigint identity key; pruned after 30 days. */
export const checks = pgTable(
  'checks',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => endpoints.id, { onDelete: 'cascade' }),
    checkedAt: ts('checked_at').notNull().defaultNow(),
    /** null when the request failed before a response (DNS, timeout, TLS). */
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    ok: boolean('ok').notNull(),
    error: text('error'),
  },
  (t) => [
    index('checks_endpoint_time_idx').on(t.endpointId, t.checkedAt.desc()),
    // Append-only by time, so a tiny BRIN index is enough for the nightly prune.
    index('checks_checked_at_brin').using('brin', t.checkedAt),
  ],
);

/**
 * Per-endpoint daily check totals (UTC days), written by the nightly prune job before raw checks
 * older than 30 days are deleted. Monthly reports read these, so they outlive the raw checks.
 */
export const endpointDailyStats = pgTable(
  'endpoint_daily_stats',
  {
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => endpoints.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    checks: integer('checks').notNull(),
    ok: integer('ok').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.endpointId, t.day] }),
    check('endpoint_daily_stats_counts_check', sql`${t.ok} between 0 and ${t.checks}`),
  ],
);

/** Raised by the worker; see the alert rule in the README. At most one open alert per endpoint. */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The endpoint that is failing (null for future project-level alert kinds). */
    endpointId: uuid('endpoint_id').references(() => endpoints.id, { onDelete: 'cascade' }),
    /** 'endpoint_down' today; plain text so new kinds need no enum migration. */
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    relatedDeployId: uuid('related_deploy_id').references(() => deploys.id, { onDelete: 'set null' }),
  },
  (t) => [
    index('alerts_project_time_idx').on(t.projectId, t.createdAt.desc()),
    index('alerts_open_idx')
      .on(t.projectId)
      .where(sql`${t.resolvedAt} is null`),
    uniqueIndex('alerts_one_open_per_endpoint')
      .on(t.endpointId)
      .where(sql`${t.resolvedAt} is null`),
  ],
);

export type User = typeof users.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Deploy = typeof deploys.$inferSelect;
export type Scan = typeof scans.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type Endpoint = typeof endpoints.$inferSelect;
export type Check = typeof checks.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type ScanVariable = typeof scanVariables.$inferSelect;
export type EndpointDailyStat = typeof endpointDailyStats.$inferSelect;

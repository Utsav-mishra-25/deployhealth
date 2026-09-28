import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_owner_name_uq').on(t.ownerId, t.name)],
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

/** Phase 2: URLs the worker checks on a schedule. */
export const endpoints = pgTable('endpoints', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  method: text('method', { enum: ['GET', 'HEAD'] })
    .notNull()
    .default('GET'),
  intervalSeconds: integer('interval_seconds').notNull().default(60),
  expectedStatus: integer('expected_status').notNull().default(200),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Phase 2: one row per uptime check. High volume, so a bigint identity key. */
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
  (t) => [index('checks_endpoint_time_idx').on(t.endpointId, t.checkedAt.desc())],
);

/** Phase 2: raised by the worker; see the correlation rule in the README. */
export const alerts = pgTable(
  'alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Plain text until Phase 2 settles the set of kinds. */
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
  ],
);

export type User = typeof users.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Deploy = typeof deploys.$inferSelect;
export type Scan = typeof scans.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type Endpoint = typeof endpoints.$inferSelect;
export type Check = typeof checks.$inferSelect;
export type Alert = typeof alerts.$inferSelect;

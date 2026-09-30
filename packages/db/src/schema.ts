import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { EnvScope } from '@deployhealth/core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const deploySource = pgEnum('deploy_source', ['ingest', 'manual']);
export const findingKind = pgEnum('finding_kind', ['missing', 'unused', 'mismatch']);
/** What the GitHub App does on a project's pull requests: nothing, comment (neutral check), or fail the check. */
export const prCheckMode = pgEnum('pr_check_mode', ['off', 'comment', 'strict']);

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
    /** GitHub App pull request checks for this repo (only once the App is installed on it). */
    prCheckMode: prCheckMode('pr_check_mode').notNull().default('comment'),
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
    /** Whether the CLI sent the full variable list (older CLIs don't), so scan_variables is complete. */
    variablesReported: boolean('variables_reported').notNull().default(false),
    /**
     * Every scope with the env files it has (CLI 0.2.0+); null from older CLIs. A scope with none
     * has no MISSING rows: the project page shows a notice, and deploy correlation looks at the
     * variables it newly references instead.
     */
    envScopes: jsonb('env_scopes').$type<EnvScope[]>(),
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
    /** Every reference has an inline default in code (CLI 0.2.0+), so it needn't be defined. */
    optional: boolean('optional').notNull().default(false),
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

// ---------------------------------------------------------------------------------------------
// GitHub App: installations, pull request checks, webhook deliveries
// ---------------------------------------------------------------------------------------------

/**
 * A GitHub App installation, from signed webhook deliveries only. `user_id` links it to the
 * deployhealth account whose GitHub id installed it (`installer_github_id`, the delivery's sender):
 * set when the installation arrives if that user exists, else at their next sign-in. Pull requests
 * are checked only for projects owned by that user.
 */
export const installations = pgTable(
  'installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    githubInstallationId: bigint('github_installation_id', { mode: 'number' }).notNull().unique(),
    accountLogin: text('account_login').notNull(),
    /** 'User' or 'Organization'. */
    accountType: text('account_type').notNull(),
    installerGithubId: bigint('installer_github_id', { mode: 'number' }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    suspendedAt: ts('suspended_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('installations_installer_idx').on(t.installerGithubId), index('installations_user_idx').on(t.userId)],
);

/** The repositories an installation can see ("owner/repo"), kept in sync from webhooks. */
export const installationRepos = pgTable(
  'installation_repos',
  {
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    repoFullName: text('repo_full_name').notNull(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.repoFullName] }), index('installation_repos_repo_idx').on(sql`lower(${t.repoFullName})`)],
);

/** A variable reference in a pull request's code. At most PR_REFS_PER_VAR are stored per variable. */
export interface PrVarRef {
  file: string;
  line: number;
}
export interface PrAddedVar {
  name: string;
  refs: PrVarRef[];
  /** References in total (refs may be truncated). */
  total: number;
  /** In the .env.example of every scope that references it. */
  declared: boolean;
}
export interface PrRemovedVar {
  name: string;
  refs: PrVarRef[];
  total: number;
}
export interface PrRenamedVar {
  from: string;
  to: string;
  file: string;
  line: number;
  declared: boolean;
}
export interface PrEnvFile {
  path: string;
  /** Committed by this pull request (not already on the base branch). */
  added: boolean;
}

/** One check of one pull request head. A new push adds a row; the comment and check run are updated. */
export const prChecks = pgTable(
  'pr_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha').notNull(),
    authorLogin: text('author_login').notNull(),
    authorIsAgent: boolean('author_is_agent').notNull().default(false),
    agentName: text('agent_name'),
    addedVars: jsonb('added_vars').$type<PrAddedVar[]>().notNull().default([]),
    removedVars: jsonb('removed_vars').$type<PrRemovedVar[]>().notNull().default([]),
    renamedVars: jsonb('renamed_vars').$type<PrRenamedVar[]>().notNull().default([]),
    undeclaredVars: jsonb('undeclared_vars').$type<string[]>().notNull().default([]),
    committedEnvFiles: jsonb('committed_env_files').$type<PrEnvFile[]>().notNull().default([]),
    secretHits: integer('secret_hits').notNull().default(0),
    conclusion: text('conclusion', { enum: ['neutral', 'success', 'failure'] }).notNull(),
    commentId: bigint('comment_id', { mode: 'number' }),
    checkRunId: bigint('check_run_id', { mode: 'number' }),
    /** Set when the pull request is closed or merged; cleared if it's reopened. */
    closedAt: ts('closed_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pr_checks_head_uq').on(t.projectId, t.prNumber, t.headSha),
    index('pr_checks_project_created_idx').on(t.projectId, t.createdAt),
    check('pr_checks_conclusion_check', sql`${t.conclusion} in ('neutral', 'success', 'failure')`),
  ],
);

/** X-GitHub-Delivery ids already accepted, so a redelivery isn't processed twice. Pruned after 24 h. */
export const webhookDeliveries = pgTable('webhook_deliveries', {
  deliveryId: text('delivery_id').primaryKey(),
  receivedAt: ts('received_at').notNull().defaultNow(),
});

/**
 * One row per target hostname: the earliest time its next check may start. The claim query hands
 * out start times HOST_CHECK_SPACING_MS apart per hostname, across all users, and saves the next
 * free one here. A row whose time has passed means "free now".
 */
export const checkHosts = pgTable('check_hosts', {
  hostname: text('hostname').primaryKey(),
  nextSlotAt: ts('next_slot_at').notNull(),
});

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
export type CheckHost = typeof checkHosts.$inferSelect;
export type Installation = typeof installations.$inferSelect;
export type PrCheck = typeof prChecks.$inferSelect;
export type NewPrCheck = typeof prChecks.$inferInsert;
export type PrCheckMode = (typeof prCheckMode.enumValues)[number];

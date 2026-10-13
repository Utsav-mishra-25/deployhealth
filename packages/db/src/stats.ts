import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';
import { deploys, installations, prChecks, projects, scans, users } from './schema';

// Usage counts for the operator (`pnpm --filter @deployhealth/db stats`, docs/deploy-railway.md
// "Check usage"). Like delete-user, it isn't owner-scoped and isn't exported from the package
// index: no route reaches it. Counts only, never names, logins or repository names.

export interface UsageStatsOptions {
  /** GitHub logins to leave out (the operator's own accounts), matched case-insensitively. */
  excludeLogins?: readonly string[];
}

export interface CreatedCounts {
  total: number;
  last7Days: number;
  last30Days: number;
}

export interface UsageStats {
  users: CreatedCounts;
  installations: CreatedCounts & { userAccounts: number; organizations: number };
  projects: CreatedCounts;
  /** Projects with a scan or a pull request check in the last 7 days: the north star. */
  weeklyActiveProjects: number;
  scansLast7Days: number;
  pullRequestChecksLast7Days: number;
  /** How many users the --exclude-login values matched (the demo and dev users aren't counted here). */
  excludedByLogin: number;
}

/**
 * Run `fn` in one READ ONLY transaction: Postgres refuses any write inside it, so the stats can't
 * change anything even by mistake. Exported for the test that proves it.
 */
export function readOnly<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as Db), { accessMode: 'read only' });
}

/**
 * Counts on the database clock, leaving out the demo (-1) and dev (-2) users, every user whose
 * login is in `excludeLogins`, what they own, the installations linked to them or installed from
 * their GitHub account, and the demo's installation. Installations nobody has linked yet count.
 */
export async function usageStats(db: Db, options: UsageStatsOptions = {}): Promise<UsageStats> {
  const logins = [...new Set((options.excludeLogins ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean))];
  const byLogin: SQL = logins.length > 0 ? sql`lower(u.login) in (${sql.join(logins.map((l) => sql`${l}`), sql`, `)})` : sql`false`;

  return readOnly(db, async (tx) => {
    const result = await tx.execute<Record<string, number>>(sql`
      with excluded as (
        select u.id, u.github_id from ${users} u where u.github_id <= 0 or ${byLogin}
      ),
      counted_users as (
        select u.id, u.created_at from ${users} u where u.id not in (select id from excluded)
      ),
      counted_installations as (
        select i.account_type, i.created_at from ${installations} i
        where i.github_installation_id > 0
          and (i.user_id is null or i.user_id not in (select id from excluded))
          and i.installer_github_id not in (select github_id from excluded)
      ),
      counted_projects as (
        select p.id, p.created_at from ${projects} p where p.owner_id in (select id from counted_users)
      ),
      recent_scans as (
        select d.project_id from ${scans} s join ${deploys} d on d.id = s.deploy_id
        where s.created_at >= now() - interval '7 days' and d.project_id in (select id from counted_projects)
      ),
      recent_pr_checks as (
        select pc.project_id, pc.created_at from ${prChecks} pc
        where pc.updated_at >= now() - interval '7 days' and pc.project_id in (select id from counted_projects)
      )
      select
        (select count(*) from counted_users)::int as users,
        (select count(*) from counted_users where created_at >= now() - interval '7 days')::int as users_7,
        (select count(*) from counted_users where created_at >= now() - interval '30 days')::int as users_30,
        (select count(*) from counted_installations)::int as installations,
        (select count(*) from counted_installations where created_at >= now() - interval '7 days')::int as installations_7,
        (select count(*) from counted_installations where created_at >= now() - interval '30 days')::int as installations_30,
        (select count(*) from counted_installations where account_type = 'Organization')::int as organizations,
        (select count(*) from counted_projects)::int as projects,
        (select count(*) from counted_projects where created_at >= now() - interval '7 days')::int as projects_7,
        (select count(*) from counted_projects where created_at >= now() - interval '30 days')::int as projects_30,
        (select count(*) from (select project_id from recent_scans union select project_id from recent_pr_checks) a)::int as weekly_active,
        (select count(*) from recent_scans)::int as scans_7,
        (select count(*) from recent_pr_checks where created_at >= now() - interval '7 days')::int as pr_checks_7,
        (select count(*) from excluded where github_id > 0)::int as excluded_by_login
    `);
    const r = result.rows[0]!;
    return {
      users: { total: r.users!, last7Days: r.users_7!, last30Days: r.users_30! },
      installations: {
        total: r.installations!,
        last7Days: r.installations_7!,
        last30Days: r.installations_30!,
        userAccounts: r.installations! - r.organizations!,
        organizations: r.organizations!,
      },
      projects: { total: r.projects!, last7Days: r.projects_7!, last30Days: r.projects_30! },
      weeklyActiveProjects: r.weekly_active!,
      scansLast7Days: r.scans_7!,
      pullRequestChecksLast7Days: r.pr_checks_7!,
      excludedByLogin: r.excluded_by_login!,
    };
  });
}

import { endpointLabel, findingsDiff, type FindingRow, type ReportData, type ReportMonth, type ReportProject } from '@deployhealth/core';
import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import type { Db } from './client';
import { deployConfigChange } from './deploy-config';
import { uptimeBetween, uptimeRatio } from './monitoring';
import { alerts, clients, deploys, endpoints, findings, projects, scans, users, type Project } from './schema';

/**
 * The monthly report for one client: every project assigned to it, for one UTC month.
 *
 * This query is NOT owner-scoped: signed share links reach it with only a client id. So it reads
 * strictly by that client id, and only projects that belong to the client's own user. Owner
 * routes must look the client up with getClientBySlug(db, userId, slug) first and pass its id.
 * Returns null for an unknown client.
 */
export async function getClientReport(db: Db, clientId: string, month: ReportMonth, now = new Date()): Promise<ReportData | null> {
  const [row] = await db
    .select({ client: clients, name: users.name, login: users.login })
    .from(clients)
    .innerJoin(users, eq(users.id, clients.userId))
    .where(eq(clients.id, clientId));
  if (!row) return null;
  const { client } = row;

  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.clientId, client.id), eq(projects.ownerId, client.userId)))
    .orderBy(asc(projects.name));

  return {
    client: { id: client.id, name: client.name, contactEmail: client.contactEmail },
    // "Prepared by": the owner's GitHub name, else their login. Nothing else about them.
    preparedBy: row.name?.trim() || row.login,
    month,
    generatedAt: now,
    projects: await Promise.all(projectRows.map((project) => projectReport(db, project, month, now))),
  };
}

async function projectReport(db: Db, project: Project, month: ReportMonth, now: Date): Promise<ReportProject> {
  // A month still in progress counts up to now.
  const end = month.to.getTime() < now.getTime() ? month.to : now;

  const [endpointRows, alertRows, monthDeploys, [before], [latest]] = await Promise.all([
    db.select().from(endpoints).where(eq(endpoints.projectId, project.id)).orderBy(asc(endpoints.createdAt)),
    db
      .select({ alert: alerts, url: endpoints.url, name: endpoints.name })
      .from(alerts)
      .leftJoin(endpoints, eq(endpoints.id, alerts.endpointId))
      .where(and(eq(alerts.projectId, project.id), gte(alerts.createdAt, month.from), lt(alerts.createdAt, month.to)))
      .orderBy(asc(alerts.createdAt)),
    db
      .select()
      .from(deploys)
      .where(and(eq(deploys.projectId, project.id), gte(deploys.deployedAt, month.from), lt(deploys.deployedAt, month.to)))
      .orderBy(asc(deploys.deployedAt)),
    // The last deploy before the month, to diff the month's first deploy against.
    db
      .select()
      .from(deploys)
      .where(and(eq(deploys.projectId, project.id), lt(deploys.deployedAt, month.from)))
      .orderBy(desc(deploys.deployedAt))
      .limit(1),
    db.select().from(deploys).where(eq(deploys.projectId, project.id)).orderBy(desc(deploys.deployedAt)).limit(1),
  ]);

  const reportEndpoints = await Promise.all(
    endpointRows.map(async (e) => {
      const tally = await uptimeBetween(db, e.id, month.from, end);
      return { label: endpointLabel(e), url: e.url, checks: tally.checks, ok: tally.ok, uptime: uptimeRatio(tally) };
    }),
  );

  const incidentEnd = end.getTime();
  const incidents = await Promise.all(
    alertRows.map(async (r) => ({
      endpoint: r.url ? endpointLabel({ url: r.url, name: r.name }) : 'project',
      openedAt: r.alert.createdAt,
      resolvedAt: r.alert.resolvedAt,
      durationMs: Math.max(0, (r.alert.resolvedAt?.getTime() ?? incidentEnd) - r.alert.createdAt.getTime()),
      message: r.alert.message,
      afterDeploy: await afterDeploy(db, project.id, r.alert.relatedDeployId),
    })),
  );

  let previous = before ? await latestScanFindings(db, before.id) : null;
  const reportDeploys = [];
  for (const deploy of monthDeploys) {
    const current = await latestScanFindings(db, deploy.id);
    if (!current) continue;
    reportDeploys.push({ sha: deploy.sha, branch: deploy.branch, deployedAt: deploy.deployedAt, ...findingsDiff(previous, current) });
    previous = current;
  }

  return {
    name: project.name,
    repoFullName: project.repoFullName,
    endpoints: reportEndpoints,
    incidents,
    deploys: reportDeploys,
    openFindings: latest ? ((await latestScanFindings(db, latest.id)) ?? []) : [],
  };
}

/**
 * The deploy an alert linked, and how many settings it newly left undeclared (counted as the
 * alert's message counts them); null without a linked deploy (none, or deleted since). Read
 * within the project, so a share link reaches nothing outside the client's projects.
 */
async function afterDeploy(db: Db, projectId: string, deployId: string | null): Promise<{ newConfigIssues: number } | null> {
  if (!deployId) return null;
  const [deploy] = await db
    .select({ id: deploys.id, deployedAt: deploys.deployedAt })
    .from(deploys)
    .where(and(eq(deploys.id, deployId), eq(deploys.projectId, projectId)));
  if (!deploy) return null;
  const change = await deployConfigChange(db, projectId, deploy);
  return { newConfigIssues: change.newMissing.length + change.newUndeclared.length };
}

/** The findings of a deploy's latest scan; null when it has no scan. */
async function latestScanFindings(db: Db, deployId: string): Promise<FindingRow[] | null> {
  const [scan] = await db.select({ id: scans.id }).from(scans).where(eq(scans.deployId, deployId)).orderBy(desc(scans.createdAt)).limit(1);
  if (!scan) return null;
  return db
    .select({ kind: findings.kind, var_name: findings.varName, file: findings.file, line: findings.line, env_file: findings.envFile })
    .from(findings)
    .where(eq(findings.scanId, scan.id))
    .orderBy(asc(findings.kind), asc(findings.varName), asc(findings.file), asc(findings.line));
}

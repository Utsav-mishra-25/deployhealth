import { endpointLabel, type HandoffData } from '@deployhealth/core';
import { and, asc, eq, gte, isNull, or } from 'drizzle-orm';
import type { Db } from './client';
import { getClientForOwner } from './clients';
import { listEndpointsForOwner, startOfUtcDay, uptimeBetween, uptimeRatio } from './monitoring';
import { getLatestScan, getProjectForOwner, getScanVariables, listDeploys } from './queries';
import { alerts, endpoints } from './schema';

/** The handoff's uptime and alert window: today and the 29 days before it (UTC). */
export const HANDOFF_WINDOW_DAYS = 30;

/** Everything in a handoff except the Action snippet, which needs the instance's public URL. */
export type HandoffSource = Omit<HandoffData, 'actionSnippet'>;

/**
 * A project's handoff data, owner-scoped (null if the project isn't the owner's). Names only:
 * variables and findings come from the scanner, which never reads env values.
 */
export async function getHandoffData(db: Db, ownerId: string, projectId: string, now = new Date()): Promise<HandoffSource | null> {
  const project = await getProjectForOwner(db, projectId, ownerId);
  if (!project) return null;

  const from = new Date(startOfUtcDay(now).getTime() - (HANDOFF_WINDOW_DAYS - 1) * 86_400_000);
  const [client, [latest], endpointRows, alertRows] = await Promise.all([
    project.clientId ? getClientForOwner(db, ownerId, project.clientId) : null,
    listDeploys(db, project.id, 1),
    listEndpointsForOwner(db, ownerId, project.id),
    db
      .select({ alert: alerts, url: endpoints.url, name: endpoints.name })
      .from(alerts)
      .leftJoin(endpoints, eq(endpoints.id, alerts.endpointId))
      .where(and(eq(alerts.projectId, project.id), or(gte(alerts.createdAt, from), isNull(alerts.resolvedAt), gte(alerts.resolvedAt, from))))
      .orderBy(asc(alerts.createdAt)),
  ]);

  const detail = latest ? await getLatestScan(db, project.id, latest.deploy.id) : null;
  const variables = detail ? await getScanVariables(db, detail.scan.id) : [];
  const handoffEndpoints = await Promise.all(
    endpointRows.map(async (e) => ({
      label: endpointLabel(e),
      url: e.url,
      method: e.method,
      intervalSeconds: e.intervalSeconds,
      expectedStatus: e.expectedStatus,
      enabled: e.enabled,
      uptime: uptimeRatio(await uptimeBetween(db, e.id, from, now)),
    })),
  );
  const withData = handoffEndpoints.map((e) => e.uptime).filter((u): u is number => u !== null);

  return {
    generatedAt: now,
    project: { name: project.name, repoFullName: project.repoFullName },
    client: client ? { name: client.name, contactEmail: client.contactEmail } : null,
    scan: detail
      ? { sha: detail.deploy.sha, branch: detail.deploy.branch, deployedAt: detail.deploy.deployedAt, variablesReported: detail.scan.variablesReported }
      : null,
    variables,
    envScopes: null,
    findings: detail?.findings ?? [],
    endpoints: handoffEndpoints,
    window: { from, to: now },
    uptime: withData.length ? withData.reduce((a, b) => a + b, 0) / withData.length : null,
    alerts: alertRows.map((r) => ({
      endpoint: r.url ? endpointLabel({ url: r.url, name: r.name }) : 'project',
      openedAt: r.alert.createdAt,
      resolvedAt: r.alert.resolvedAt,
      message: r.alert.message,
    })),
    deployNotes: project.deployNotes,
  };
}

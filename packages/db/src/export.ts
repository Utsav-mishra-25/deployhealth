import { asc, eq, inArray, or } from 'drizzle-orm';
import type { Db } from './client';
import {
  alerts,
  clients,
  deploys,
  endpointDailyStats,
  endpoints,
  findings,
  installationRepos,
  installations,
  prChecks,
  projects,
  scans,
  scanVariables,
  users,
  type PrAddedVar,
  type PrEnvFile,
  type PrRemovedVar,
  type PrRenamedVar,
} from './schema';
import type { EnvScope } from '@deployhealth/core';

/**
 * "Export my data" on /account: everything the signed-in user owns, as one JSON document.
 * Owner-scoped like every query (it takes the user's id; test/isolation.test.ts). Names, paths and
 * line numbers only, as stored: env values are never stored, so none can be exported. Left out on
 * purpose: ingest token hashes and hints, alert webhook URLs (they work like passwords: shown as
 * "set"), pull request checks' GitHub comment and check-run ids, and raw uptime checks (daily
 * totals are included). One READ ONLY, REPEATABLE READ transaction, so it's one consistent snapshot.
 */

export const EXPORT_FORMAT = 'deployhealth-export/1';

export interface UserExport {
  format: typeof EXPORT_FORMAT;
  exportedAt: string;
  account: { githubId: number; login: string; name: string | null; email: string | null; createdAt: string };
  clients: Array<{ id: string; name: string; slug: string; contactEmail: string | null; notes: string | null; createdAt: string }>;
  projects: Array<{
    id: string;
    name: string;
    repository: string;
    clientId: string | null;
    alertWebhook: 'set' | null;
    pullRequestCheckMode: string;
    deployNotes: string | null;
    createdAt: string;
  }>;
  deploys: Array<{ id: string; projectId: string; sha: string; branch: string; deployedAt: string; createdAt: string }>;
  scans: Array<{
    id: string;
    deployId: string;
    createdAt: string;
    counts: { missing: number; unused: number; mismatch: number };
    envScopes: EnvScope[] | null;
    findings: Array<{ kind: string; variable: string; file: string | null; line: number | null; envFile: string | null }>;
    variables: Array<{ scope: string; variable: string; definedIn: string[]; optional: boolean }>;
  }>;
  endpoints: Array<{
    id: string;
    projectId: string;
    name: string | null;
    url: string;
    method: string;
    intervalSeconds: number;
    expectedStatus: number;
    enabled: boolean;
    createdAt: string;
    dailyTotals: Array<{ day: string; checks: number; ok: number }>;
  }>;
  alerts: Array<{
    id: string;
    projectId: string;
    endpointId: string | null;
    kind: string;
    message: string;
    openedAt: string;
    resolvedAt: string | null;
    /** null while open; alerts resolved before 0010 read as 'recovered'. */
    resolution: 'recovered' | 'paused' | null;
    deployId: string | null;
  }>;
  pullRequestChecks: Array<{
    projectId: string;
    number: number;
    headSha: string;
    baseSha: string;
    author: string;
    authorIsAgent: boolean;
    agent: string | null;
    conclusion: string;
    addedVariables: PrAddedVar[];
    removedVariables: PrRemovedVar[];
    renamedVariables: PrRenamedVar[];
    undeclaredVariables: string[];
    committedEnvFiles: PrEnvFile[];
    secretShapedStrings: number;
    closedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  githubAppInstallations: Array<{
    account: string;
    accountType: string;
    /** 'all' (every repository of the account) or 'selected'; null until GitHub has said. */
    repositorySelection: string | null;
    suspendedAt: string | null;
    createdAt: string;
    repositories: string[];
  }>;
}

const iso = (date: Date) => date.toISOString();
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

/** The user's data, or null when there is no such user. */
export async function exportUserData(db: Db, userId: string, now: Date = new Date()): Promise<UserExport | null> {
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) return null;

    const projectRows = await tx.select().from(projects).where(eq(projects.ownerId, userId)).orderBy(asc(projects.createdAt), asc(projects.name));
    const projectIds = projectRows.map((p) => p.id);
    const deployRows = projectIds.length ? await tx.select().from(deploys).where(inArray(deploys.projectId, projectIds)).orderBy(asc(deploys.deployedAt)) : [];
    const deployIds = deployRows.map((d) => d.id);
    const scanRows = deployIds.length ? await tx.select().from(scans).where(inArray(scans.deployId, deployIds)).orderBy(asc(scans.createdAt)) : [];
    const scanIds = scanRows.map((s) => s.id);
    const findingRows = scanIds.length ? await tx.select().from(findings).where(inArray(findings.scanId, scanIds)).orderBy(asc(findings.id)) : [];
    const variableRows = scanIds.length
      ? await tx.select().from(scanVariables).where(inArray(scanVariables.scanId, scanIds)).orderBy(asc(scanVariables.scope), asc(scanVariables.varName))
      : [];
    const endpointRows = projectIds.length ? await tx.select().from(endpoints).where(inArray(endpoints.projectId, projectIds)).orderBy(asc(endpoints.createdAt)) : [];
    const endpointIds = endpointRows.map((e) => e.id);
    const totalRows = endpointIds.length
      ? await tx.select().from(endpointDailyStats).where(inArray(endpointDailyStats.endpointId, endpointIds)).orderBy(asc(endpointDailyStats.day))
      : [];
    const alertRows = projectIds.length ? await tx.select().from(alerts).where(inArray(alerts.projectId, projectIds)).orderBy(asc(alerts.createdAt)) : [];
    const prRows = projectIds.length
      ? await tx.select().from(prChecks).where(inArray(prChecks.projectId, projectIds)).orderBy(asc(prChecks.createdAt), asc(prChecks.prNumber))
      : [];
    const installationRows = await tx
      .select()
      .from(installations)
      .where(or(eq(installations.userId, userId), eq(installations.installerGithubId, user.githubId)))
      .orderBy(asc(installations.createdAt));
    const repoRows = installationRows.length
      ? await tx
          .select()
          .from(installationRepos)
          .where(inArray(installationRepos.installationId, installationRows.map((i) => i.id)))
          .orderBy(asc(installationRepos.repoFullName))
      : [];
    const clientRows = await tx.select().from(clients).where(eq(clients.userId, userId)).orderBy(asc(clients.createdAt), asc(clients.name));

    const byKey = <T, K>(rows: T[], key: (row: T) => K) => {
      const map = new Map<K, T[]>();
      for (const row of rows) {
        const list = map.get(key(row));
        if (list) list.push(row);
        else map.set(key(row), [row]);
      }
      return map;
    };
    const findingsByScan = byKey(findingRows, (f) => f.scanId);
    const variablesByScan = byKey(variableRows, (v) => v.scanId);
    const totalsByEndpoint = byKey(totalRows, (t) => t.endpointId);
    const reposByInstallation = byKey(repoRows, (r) => r.installationId);

    return {
      format: EXPORT_FORMAT,
      exportedAt: iso(now),
      account: { githubId: user.githubId, login: user.login, name: user.name, email: user.email, createdAt: iso(user.createdAt) },
      clients: clientRows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, contactEmail: c.contactEmail, notes: c.notes, createdAt: iso(c.createdAt) })),
      projects: projectRows.map((p) => ({
        id: p.id,
        name: p.name,
        repository: p.repoFullName,
        clientId: p.clientId,
        alertWebhook: p.alertWebhookUrl ? ('set' as const) : null,
        pullRequestCheckMode: p.prCheckMode,
        deployNotes: p.deployNotes,
        createdAt: iso(p.createdAt),
      })),
      deploys: deployRows.map((d) => ({ id: d.id, projectId: d.projectId, sha: d.sha, branch: d.branch, deployedAt: iso(d.deployedAt), createdAt: iso(d.createdAt) })),
      scans: scanRows.map((s) => ({
        id: s.id,
        deployId: s.deployId,
        createdAt: iso(s.createdAt),
        counts: { missing: s.missingCount, unused: s.unusedCount, mismatch: s.mismatchCount },
        envScopes: s.envScopes,
        findings: (findingsByScan.get(s.id) ?? []).map((f) => ({ kind: f.kind, variable: f.varName, file: f.file, line: f.line, envFile: f.envFile })),
        variables: (variablesByScan.get(s.id) ?? []).map((v) => ({ scope: v.scope, variable: v.varName, definedIn: v.definedIn, optional: v.optional })),
      })),
      endpoints: endpointRows.map((e) => ({
        id: e.id,
        projectId: e.projectId,
        name: e.name,
        url: e.url,
        method: e.method,
        intervalSeconds: e.intervalSeconds,
        expectedStatus: e.expectedStatus,
        enabled: e.enabled,
        createdAt: iso(e.createdAt),
        dailyTotals: (totalsByEndpoint.get(e.id) ?? []).map((t) => ({ day: t.day, checks: t.checks, ok: t.ok })),
      })),
      alerts: alertRows.map((a) => ({
        id: a.id,
        projectId: a.projectId,
        endpointId: a.endpointId,
        kind: a.kind,
        message: a.message,
        openedAt: iso(a.createdAt),
        resolvedAt: isoOrNull(a.resolvedAt),
        resolution: a.resolvedAt ? (a.resolution ?? 'recovered') : null,
        deployId: a.relatedDeployId,
      })),
      pullRequestChecks: prRows.map((c) => ({
        projectId: c.projectId,
        number: c.prNumber,
        headSha: c.headSha,
        baseSha: c.baseSha,
        author: c.authorLogin,
        authorIsAgent: c.authorIsAgent,
        agent: c.agentName,
        conclusion: c.conclusion,
        addedVariables: c.addedVars,
        removedVariables: c.removedVars,
        renamedVariables: c.renamedVars,
        undeclaredVariables: c.undeclaredVars,
        committedEnvFiles: c.committedEnvFiles,
        secretShapedStrings: c.secretHits,
        closedAt: isoOrNull(c.closedAt),
        createdAt: iso(c.createdAt),
        updatedAt: iso(c.updatedAt),
      })),
      githubAppInstallations: installationRows.map((i) => ({
        account: i.accountLogin,
        accountType: i.accountType,
        repositorySelection: i.repositorySelection,
        suspendedAt: isoOrNull(i.suspendedAt),
        createdAt: iso(i.createdAt),
        repositories: (reposByInstallation.get(i.id) ?? []).map((r) => r.repoFullName),
      })),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

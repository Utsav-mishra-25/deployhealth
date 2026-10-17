import { newMissingVars, newUndeclaredVars, type RequiredVariable } from '@deployhealth/core';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import { deploys, findings, scans, scanVariables } from './schema';

// Not exported from the package's index: these read by project and deploy id, not by owner. The
// alert path (monitoring.ts) and the monthly report (reports.ts) call them after their own scoping.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
/** A connection or a transaction: everything here only reads. */
type Queryable = Db | Tx;

/** What a deploy added to the config, against the previous scanned deploy. */
export interface DeployConfigChange {
  newMissing: string[];
  /** Newly referenced in scopes with no env file (which have no MISSING rows); [] for older scans. */
  newUndeclared: string[];
}

/**
 * The MISSING vars a deploy's latest scan has that the previous scanned deploy's latest scan
 * didn't, and, for scopes with no env file (CLI 0.2.0+ reports them), the variables it references
 * that the previous scan didn't. The alert message (linkDeploy) and the monthly report's "after a
 * deploy that was missing N settings" both count with this.
 */
export async function deployConfigChange(
  tx: Queryable,
  projectId: string,
  deploy: { id: string; deployedAt: Date },
): Promise<DeployConfigChange> {
  const current = await latestScanOf(tx, deploy.id);
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
  const before = previous ? await latestScanOf(tx, previous.id) : null;

  const newMissing = newMissingVars(current.findings, before?.findings ?? null);
  const undeclared = current.envScopes
    ? newUndeclaredVars({ variables: await scanVariableRows(tx, current.scanId), envScopes: current.envScopes }, before ? await referencedNames(tx, before) : null)
    : [];
  return { newMissing, newUndeclared: undeclared.filter((name) => !newMissing.includes(name)) };
}

/** A deploy's latest scan: its id, env scopes (null from CLIs before 0.2.0) and findings. */
async function latestScanOf(tx: Queryable, deployId: string) {
  const [scan] = await tx
    .select({ id: scans.id, envScopes: scans.envScopes })
    .from(scans)
    .where(eq(scans.deployId, deployId))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  if (!scan) return { scanId: null, envScopes: null, findings: [] };
  const rows = await tx.select({ kind: findings.kind, var_name: findings.varName }).from(findings).where(eq(findings.scanId, scan.id));
  return { scanId: scan.id, envScopes: scan.envScopes, findings: rows };
}

async function scanVariableRows(tx: Queryable, scanId: string | null): Promise<RequiredVariable[]> {
  if (!scanId) return [];
  const rows = await tx
    .select({ scope: scanVariables.scope, var_name: scanVariables.varName, optional: scanVariables.optional })
    .from(scanVariables)
    .where(eq(scanVariables.scanId, scanId));
  return rows.map((r) => ({ scope: r.scope, var_name: r.var_name, defined_in: [], ...(r.optional ? { optional: true as const } : {}) }));
}

/**
 * Every name a scan referenced: its variable list, plus its findings' names (a scan from an older
 * CLI has no variable list, but then every reference in a scope with no env file was a MISSING row).
 */
async function referencedNames(tx: Queryable, scan: { scanId: string | null; findings: ReadonlyArray<{ var_name: string }> }): Promise<Set<string>> {
  const names = new Set(scan.findings.map((f) => f.var_name));
  for (const v of await scanVariableRows(tx, scan.scanId)) names.add(v.var_name);
  return names;
}

import { newDeclaredVars, newMissingVars, newUndeclaredVars, type RequiredVariable } from '@deployhealth/core';
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
  /**
   * Newly referenced, not optional, and in neither list above (declared, so nothing flags them).
   * Null when the scans can't be compared: no previous scanned deploy, or either scan without a
   * variable list (`variables_reported`).
   */
  newDeclared: string[] | null;
}

/**
 * The MISSING vars a deploy's latest scan has that the previous scanned deploy's latest scan
 * didn't, and, for scopes with no env file (CLI 0.2.0+ reports them), the variables it references
 * that the previous scan didn't; and every other variable it newly references (newDeclared), when
 * both scans reported a variable list. The alert message (linkDeploy) and the monthly report's
 * "after a deploy that was missing N settings" (newMissing and newUndeclared only) count with this.
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
  const variables = await scanVariableRows(tx, current.scanId);
  const previousNames = before ? await referencedNames(tx, before) : null;
  const undeclared = current.envScopes ? newUndeclaredVars({ variables, envScopes: current.envScopes }, previousNames) : [];
  const newUndeclared = undeclared.filter((name) => !newMissing.includes(name));
  // Comparable only with a previous scan and a variable list on both sides.
  const newDeclared =
    previousNames && before?.variablesReported && current.variablesReported ? newDeclaredVars(variables, previousNames, [...newMissing, ...newUndeclared]) : null;
  return { newMissing, newUndeclared, newDeclared };
}

/** A deploy's latest scan: its id, env scopes (null from CLIs before 0.2.0), whether it reported variables, and findings. */
async function latestScanOf(tx: Queryable, deployId: string) {
  const [scan] = await tx
    .select({ id: scans.id, envScopes: scans.envScopes, variablesReported: scans.variablesReported })
    .from(scans)
    .where(eq(scans.deployId, deployId))
    .orderBy(desc(scans.createdAt))
    .limit(1);
  if (!scan) return { scanId: null, envScopes: null, variablesReported: false, findings: [] };
  const rows = await tx.select({ kind: findings.kind, var_name: findings.varName }).from(findings).where(eq(findings.scanId, scan.id));
  return { scanId: scan.id, envScopes: scan.envScopes, variablesReported: scan.variablesReported, findings: rows };
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

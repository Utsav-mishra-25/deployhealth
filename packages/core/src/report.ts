import { formatDuration } from './alerts';
import { formatPercent, plural } from './format';
import { FINDING_KINDS, type FindingKind, type FindingRow } from './types';

// The monthly client report: every project of one client for one UTC month. Pure data shapes and
// the numbers-to-English summary; the queries live in @deployhealth/db, the pages in the web app.

/** A calendar month in UTC: [from, to). */
export interface ReportMonth {
  /** "2026-09" */
  key: string;
  from: Date;
  to: Date;
  /** "September 2026" */
  label: string;
}

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

function monthAt(year: number, monthIndex: number): ReportMonth {
  const from = new Date(Date.UTC(year, monthIndex, 1));
  const to = new Date(Date.UTC(year, monthIndex + 1, 1));
  return {
    key: from.toISOString().slice(0, 7),
    from,
    to,
    label: from.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

/** "2026-09" → that month; anything else → null. */
export function parseMonth(key: string | null | undefined): ReportMonth | null {
  const match = MONTH_KEY.exec(key ?? '');
  if (!match) return null;
  return monthAt(Number(match[1]), Number(match[2]) - 1);
}

/** The UTC month containing `date`. */
export function monthOf(date: Date): ReportMonth {
  return monthAt(date.getUTCFullYear(), date.getUTCMonth());
}

export function shiftMonth(month: ReportMonth, delta: number): ReportMonth {
  return monthAt(month.from.getUTCFullYear(), month.from.getUTCMonth() + delta);
}

/** A finding's identity across deploys: its kind and variable, not where it was seen. */
export interface FindingKey {
  kind: FindingKind;
  var_name: string;
}

function keySet(findings: readonly Pick<FindingRow, 'kind' | 'var_name'>[]): Map<string, FindingKey> {
  return new Map(findings.map((f) => [`${f.kind}:${f.var_name}`, { kind: f.kind, var_name: f.var_name }]));
}

const byKindThenName = (a: FindingKey, b: FindingKey) =>
  FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind) || a.var_name.localeCompare(b.var_name);

/**
 * What a deploy changed, compared with the previous scanned deploy: findings it introduced and
 * findings it fixed (by kind and variable). With no previous scan, everything counts as introduced.
 */
export function findingsDiff(
  previous: readonly Pick<FindingRow, 'kind' | 'var_name'>[] | null,
  current: readonly Pick<FindingRow, 'kind' | 'var_name'>[],
): { introduced: FindingKey[]; fixed: FindingKey[] } {
  const before = keySet(previous ?? []);
  const after = keySet(current);
  return {
    introduced: [...after].filter(([k]) => !before.has(k)).map(([, v]) => v).sort(byKindThenName),
    fixed: previous ? [...before].filter(([k]) => !after.has(k)).map(([, v]) => v).sort(byKindThenName) : [],
  };
}

export interface ReportEndpoint {
  label: string;
  url: string;
  checks: number;
  ok: number;
  /** ok / checks; null without checks this month. */
  uptime: number | null;
}

export interface ReportIncident {
  endpoint: string;
  openedAt: Date;
  resolvedAt: Date | null;
  /** Open to resolve; one still open counts up to the month's end or now, whichever is first. */
  durationMs: number;
  message: string;
}

export interface ReportDeploy {
  sha: string;
  branch: string;
  deployedAt: Date;
  introduced: FindingKey[];
  fixed: FindingKey[];
}

export interface ReportProject {
  name: string;
  repoFullName: string;
  endpoints: ReportEndpoint[];
  /** Alerts opened this month, oldest first. */
  incidents: ReportIncident[];
  /** Deploys this month, oldest first. */
  deploys: ReportDeploy[];
  /** Findings in the project's latest scan, now. */
  openFindings: FindingRow[];
}

export interface ReportData {
  client: { id: string; name: string; contactEmail: string | null };
  month: ReportMonth;
  generatedAt: Date;
  projects: ReportProject[];
}

export interface ReportTotals {
  projects: number;
  /** Average of every endpoint's uptime that has checks this month. */
  uptime: number | null;
  incidents: number;
  incidentMs: number;
  deploys: number;
  introduced: number;
  fixed: number;
  openFindings: number;
}

export function reportTotals(data: ReportData): ReportTotals {
  const uptimes = data.projects.flatMap((p) => p.endpoints.map((e) => e.uptime)).filter((u): u is number => u !== null);
  const incidents = data.projects.flatMap((p) => p.incidents);
  const deploys = data.projects.flatMap((p) => p.deploys);
  return {
    projects: data.projects.length,
    uptime: uptimes.length ? uptimes.reduce((a, b) => a + b, 0) / uptimes.length : null,
    incidents: incidents.length,
    incidentMs: incidents.reduce((sum, i) => sum + i.durationMs, 0),
    deploys: deploys.length,
    introduced: deploys.reduce((sum, d) => sum + d.introduced.length, 0),
    fixed: deploys.reduce((sum, d) => sum + d.fixed.length, 0),
    openFindings: data.projects.reduce((sum, p) => sum + p.openFindings.length, 0),
  };
}

/**
 * The plain-English line at the top of the report, computed from the numbers (no LLM):
 * "3 projects, 99.94% uptime, 1 incident (21m), 14 deploys, 2 config issues fixed".
 */
export function summaryLine(totals: ReportTotals): string {
  const uptime = totals.uptime === null ? 'no uptime data' : `${formatPercent(totals.uptime)} uptime`;
  const incidents =
    totals.incidents === 0
      ? 'no incidents'
      : totals.incidents === 1
        ? `1 incident (${formatDuration(totals.incidentMs)})`
        : `${totals.incidents} incidents (${formatDuration(totals.incidentMs)} total)`;
  const fixed = totals.fixed === 0 ? 'no config issues fixed' : `${plural(totals.fixed, 'config issue')} fixed`;
  return [plural(totals.projects, 'project'), uptime, incidents, plural(totals.deploys, 'deploy'), fixed].join(', ');
}

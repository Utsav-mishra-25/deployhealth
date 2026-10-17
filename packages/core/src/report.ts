import { formatDuration } from './alerts';
import { formatPercent } from './format';
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
  /** Open to resolve (or to the pause); one still open counts up to the month's end or now, whichever is first. */
  durationMs: number;
  /** Resolved by pausing the endpoint: technical details say so; the client-facing parts don't. */
  paused: boolean;
  /** The alert's message (names variables and a short SHA): technical details only. */
  message: string;
  /**
   * The deploy the alert linked (the 30 minutes before the first failure) and how many settings
   * it newly left undeclared (new MISSING plus new undeclared, as the alert counted them); null
   * when the alert linked no deploy.
   */
  afterDeploy: { newConfigIssues: number } | null;
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
  /** The freelancer the report is from: their GitHub name, else their login. */
  preparedBy: string;
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

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Outages named one by one in the summary before "and N more". */
export const SUMMARY_MAX_OUTAGES = 5;

/** "one setting", "two settings", "12 settings": counts up to nine in words. */
function count(n: number, noun: string): string {
  return `${n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : n} ${n === 1 ? noun : `${noun}s`}`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "30 minutes", "1 hour 5 minutes", "2 days 3 hours", "less than a minute": for clients, not "1h 5m". */
/**
 * An incident's duration in the technical details: "12m", or "12m (paused)" when pausing the
 * endpoint resolved it. Never in the client-facing table or summary.
 */
export function incidentDetailDuration(incident: Pick<ReportIncident, 'durationMs' | 'paused'>): string {
  return `${formatDuration(incident.durationMs)}${incident.paused ? ' (paused)' : ''}`;
}

export function durationWords(ms: number): string {
  const unit = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${unit(hours, 'hour')} ${unit(minutes % 60, 'minute')}` : unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${unit(days, 'day')} ${unit(hours % 24, 'hour')}` : unit(days, 'day');
}

/** "16 Oct" (UTC). */
function dayMonth(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS_SHORT[date.getUTCMonth()]}`;
}

/** "after a deploy that was missing two settings", "after a deploy", or nothing. */
function afterDeployPhrase(incident: ReportIncident): string | null {
  if (!incident.afterDeploy) return null;
  const n = incident.afterDeploy.newConfigIssues;
  return n === 0 ? 'after a deploy' : `after a deploy that was missing ${count(n, 'setting')}`;
}

/**
 * The paragraph at the top of the report, for the client: uptime, outages with date and duration,
 * updates deployed and configuration issues fixed. Built from the numbers only (no LLM), and never
 * names a variable, a file or a commit: those are under "Technical details". E.g. "In October,
 * Acme's sites were up 99.81% of the time. There was one outage (30 minutes, 16 Oct) after a
 * deploy that was missing two settings. 10 updates were deployed and seven configuration issues
 * were fixed."
 */
export function reportSummary(data: ReportData): string {
  const totals = reportTotals(data);
  const inProgress = data.generatedAt.getTime() < data.month.to.getTime();
  const monthName = data.month.from.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const when = inProgress ? `So far in ${monthName}` : `In ${monthName}`;
  const owner = `${data.client.name}'${data.client.name.endsWith('s') ? '' : 's'}`;
  const endpoints = data.projects.flatMap((p) => p.endpoints);
  const sites = endpoints.length === 1 ? 'site was' : 'sites were';
  const incidents = data.projects.flatMap((p) => p.incidents).sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());

  const sentences: string[] = [];
  if (endpoints.length === 0) sentences.push(`${when}, no sites were monitored for ${data.client.name}.`);
  else if (totals.uptime === null) sentences.push(`${when}, there was no uptime data yet for ${owner} ${endpoints.length === 1 ? 'site' : 'sites'}.`);
  else sentences.push(`${when}, ${owner} ${sites} up ${formatPercent(totals.uptime)} of the time.`);

  // How long an outage lasted, or that it's still going.
  const lasted = (i: ReportIncident) =>
    i.resolvedAt ? durationWords(i.durationMs) : inProgress ? `ongoing, ${durationWords(i.durationMs)} so far` : 'still ongoing at the end of the month';
  if (incidents.length === 1) {
    const [only] = incidents as [ReportIncident];
    const after = afterDeployPhrase(only);
    const date = dayMonth(only.openedAt);
    const outage = only.resolvedAt
      ? `There was one outage (${durationWords(only.durationMs)}, ${date})`
      : inProgress
        ? `There is one ongoing outage (since ${date}, ${durationWords(only.durationMs)} so far)`
        : `There was one outage (from ${date}, still ongoing at the end of the month)`;
    sentences.push(`${outage}${after ? ` ${after}` : ''}.`);
  } else if (incidents.length > 1) {
    const named = incidents.slice(0, SUMMARY_MAX_OUTAGES).map((i) => {
      const after = afterDeployPhrase(i);
      return `${dayMonth(i.openedAt)} (${lasted(i)}${after ? `, ${after}` : ''})`;
    });
    const more = incidents.length - named.length;
    const list = more > 0 ? `${named.join(', ')} and ${more} more` : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
    sentences.push(`There were ${count(incidents.length, 'outage')}, ${durationWords(totals.incidentMs)} in total: ${list}.`);
  } else if (endpoints.length > 0) {
    sentences.push('There were no outages.');
  }

  if (totals.deploys === 0) sentences.push('No updates were deployed.');
  else {
    const fixed = totals.fixed > 0 ? ` and ${count(totals.fixed, 'configuration issue')} ${totals.fixed === 1 ? 'was' : 'were'} fixed` : '';
    sentences.push(`${capitalize(count(totals.deploys, 'update'))} ${totals.deploys === 1 ? 'was' : 'were'} deployed${fixed}.`);
  }
  return sentences.join(' ');
}

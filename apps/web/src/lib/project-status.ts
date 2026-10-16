import { failingFor, plural } from '@deployhealth/core/browser';
import type { ProjectListItem } from '@deployhealth/db';

/**
 * One status per project on the project lists (/clients, a client's page and /demo), worst first.
 * Every field it reads comes from `listProjectsForOwner`:
 * - down: an enabled endpoint has an open alert (`uptime === 'down'`);
 * - attention: the latest deploy's latest scan has MISSING or MISMATCH rows (`counts`), a scope
 *   with no env file references non-optional variables (`undeclaredInBareScopes`), an open pull
 *   request's latest check flagged undeclared env vars, a committed env file or a secret
 *   (`openPrsFlagged`, and `openPrsWith…` for which kinds), or an endpoint is failing with no
 *   alert yet (`uptime === 'degraded'`);
 * - not_set_up: no scan and no pull request check yet (`latestScanAt`, `latestPrCheckAt`); its reason
 *   says why when the caller knows whether the user's GitHub App covers the repository (`appCovers`);
 * - healthy: everything else. UNUSED alone never changes the status; it's still listed.
 */
export type ProjectStatus = 'down' | 'attention' | 'not_set_up' | 'healthy';

export const STATUS_ORDER: readonly ProjectStatus[] = ['down', 'attention', 'not_set_up', 'healthy'];

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  down: 'Down',
  attention: 'Needs attention',
  not_set_up: 'Not set up',
  healthy: 'Healthy',
};

/** One reason on a project's row; `anchor` is a section of the project page it links to. */
export interface StatusReason {
  text: string;
  anchor?: 'pull-requests' | 'findings' | 'endpoints' | 'getting-started';
}

export interface ProjectStatusView {
  status: ProjectStatus;
  /** Non-zero findings and flags only, worst first; empty for a healthy project with nothing to list. */
  reasons: StatusReason[];
  /** The later of the latest scan and the latest pull request check; null when neither exists. */
  checkedAt: Date | null;
}

export type StatusInput = Pick<
  ProjectListItem,
  | 'counts'
  | 'uptime'
  | 'failingSince'
  | 'failingEndpoints'
  | 'openPrsWithUndeclared'
  | 'openPrsWithEnvFiles'
  | 'openPrsWithSecrets'
  | 'openPrsFlagged'
  | 'latestScanAt'
  | 'latestPrCheckAt'
  | 'undeclaredInBareScopes'
>;

/**
 * Whether the user's own GitHub App installations cover a project's repository, for the "Not set
 * up" reason: true, false, or undefined when unknown (the demo, or no App on this deployment).
 */
export type AppCovers = (repoFullName: string) => boolean | undefined;

/** "Not set up"'s reason: why nothing has been checked yet, when that's known. */
export function notSetUpReason(covered: boolean | undefined): StatusReason {
  if (covered === true) return { text: 'Waiting for the first pull request check', anchor: 'getting-started' };
  if (covered === false) return { text: 'GitHub App not installed on this repo', anchor: 'getting-started' };
  return { text: 'No scan or pull request check yet' };
}

export function projectStatus(p: StatusInput & { repoFullName?: string }, now = new Date(), appCovers?: AppCovers): ProjectStatusView {
  const reasons: StatusReason[] = [];
  if (p.uptime === 'down' || p.uptime === 'degraded') {
    const state = p.uptime === 'down' ? 'down' : 'failing';
    const subject = failingSubject(p.failingEndpoints);
    const text = p.failingSince ? failingFor(state, p.failingSince, now, subject) : `${subject ?? 'An endpoint'} ${state === 'down' ? 'is down' : 'is failing'}`;
    reasons.push({ text, anchor: 'endpoints' });
  }
  const counts = p.counts ?? { missing: 0, unused: 0, mismatch: 0 };
  if (counts.missing > 0) reasons.push({ text: `${counts.missing} missing`, anchor: 'findings' });
  if (counts.mismatch > 0) reasons.push({ text: `${counts.mismatch} mismatch`, anchor: 'findings' });
  if (p.undeclaredInBareScopes > 0) {
    reasons.push({ text: `no .env.example: ${plural(p.undeclaredInBareScopes, 'var')} undeclared`, anchor: 'findings' });
  }
  // One reason for every flagged open pull request, then what they flagged:
  // "1 open PR: committed env file, secret-shaped string".
  if (p.openPrsFlagged > 0) {
    const kinds = [
      p.openPrsWithUndeclared > 0 && 'undeclared env vars',
      p.openPrsWithEnvFiles > 0 && 'committed env file',
      p.openPrsWithSecrets > 0 && 'secret-shaped string',
    ].filter((k): k is string => Boolean(k));
    reasons.push({ text: `${plural(p.openPrsFlagged, 'open PR')}: ${kinds.join(', ')}`, anchor: 'pull-requests' });
  }
  const needsAttention = reasons.length > 0 && p.uptime !== 'down';
  if (counts.unused > 0) reasons.push({ text: `${counts.unused} unused`, anchor: 'findings' });

  const checkedAt = latest(p.latestScanAt, p.latestPrCheckAt);
  let status: ProjectStatus;
  if (p.uptime === 'down') status = 'down';
  else if (needsAttention) status = 'attention';
  else if (!checkedAt) status = 'not_set_up';
  else status = 'healthy';
  if (status === 'not_set_up') reasons.push(notSetUpReason(p.repoFullName ? appCovers?.(p.repoFullName) : undefined));
  return { status, reasons, checkedAt };
}

/** "Acme API", or "Acme API +1 more" when several endpoints are behind the status. */
export function failingSubject(labels: readonly string[]): string | undefined {
  if (labels.length === 0) return undefined;
  return labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1} more`;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export const statusRank = (status: ProjectStatus) => STATUS_ORDER.indexOf(status);

/** Worst first (down, attention, not set up, healthy), then by name. */
export function compareProjects(a: { name: string; status: ProjectStatus }, b: { name: string; status: ProjectStatus }): number {
  return statusRank(a.status) - statusRank(b.status) || a.name.localeCompare(b.name);
}

/** The worst status in a group; a group with no projects sorts after every other. */
export function worstStatusRank(statuses: readonly ProjectStatus[]): number {
  return statuses.length === 0 ? STATUS_ORDER.length : Math.min(...statuses.map(statusRank));
}

/**
 * The line above a project list: "2 of 5 projects need attention · 1 down · 1 not set up"
 * (attention counts down projects too; zero parts are left out), "3 of 4 projects healthy · 1 not
 * set up", "All 5 projects healthy". Null for an empty list.
 */
export function statusSummary(statuses: readonly ProjectStatus[]): string | null {
  const total = statuses.length;
  if (total === 0) return null;
  const count = (s: ProjectStatus) => statuses.filter((x) => x === s).length;
  const down = count('down');
  const attention = down + count('attention');
  const notSetUp = count('not_set_up');
  const of = `of ${plural(total, 'project')}`;
  if (attention > 0) {
    const parts = [`${attention} ${of} ${attention === 1 ? 'needs' : 'need'} attention`];
    if (down > 0) parts.push(`${down} down`);
    if (notSetUp > 0) parts.push(`${notSetUp} not set up`);
    return parts.join(' · ');
  }
  if (notSetUp > 0) return `${total - notSetUp} ${of} healthy · ${notSetUp} not set up`;
  return total === 1 ? '1 project, healthy' : `All ${total} projects healthy`;
}

/** Each project with its status, sorted worst first then by name. */
export function rankProjects<T extends StatusInput & { name: string; repoFullName?: string }>(
  projects: readonly T[],
  now = new Date(),
  appCovers?: AppCovers,
): Array<T & ProjectStatusView> {
  return projects.map((p) => ({ ...p, ...projectStatus(p, now, appCovers) })).sort(compareProjects);
}

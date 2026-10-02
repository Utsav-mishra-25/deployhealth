import { ALERT_FAILURE_THRESHOLD, DEPLOY_LINK_WINDOW_MINUTES } from './constants';

// Pure alerting logic shared by the worker (decisions, messages) and the web app (status badges).

export type AlertAction = 'open' | 'resolve' | 'none';

export interface AlertInputs {
  /** Result of the check that was just recorded. */
  ok: boolean;
  /** Failed checks in a row, including this one (0 when `ok`). */
  consecutiveFailures: number;
  /** Whether the endpoint has ever recorded an ok check (including this one). */
  hasOkHistory: boolean;
  hasOpenAlert: boolean;
}

/**
 * The alert state machine, evaluated after every check:
 * - ok check with an open alert → resolve it
 * - failed check, no open alert, at least ALERT_FAILURE_THRESHOLD failures in a row, and the
 *   endpoint has worked at least once → open one
 * - anything else → nothing (an endpoint that has never been up never alerts)
 */
export function decideAlert(input: AlertInputs): AlertAction {
  if (input.ok) return input.hasOpenAlert ? 'resolve' : 'none';
  if (input.hasOpenAlert || !input.hasOkHistory) return 'none';
  return input.consecutiveFailures >= ALERT_FAILURE_THRESHOLD ? 'open' : 'none';
}

/** The parts of an endpoint that name it. */
export interface EndpointRef {
  url: string;
  name?: string | null;
}

/**
 * How alerts, badges and webhooks name an endpoint: its name when set ("Acme API"), otherwise its
 * host ("api.acme.com").
 */
export function endpointLabel(endpoint: EndpointRef): string {
  const name = endpoint.name?.trim();
  if (name) return name;
  try {
    return new URL(endpoint.url).host;
  } catch {
    return endpoint.url;
  }
}

/** "under a minute", "4m", "1h 5m", "2d 3h". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

/**
 * The note next to a status badge while the latest check is failing: "Down for 21m" (open alert)
 * or "Failing for 1m" (not alerting yet), or "Acme API down for 21m" with a subject. `since` is
 * the first failed check of the current run.
 */
export function failingFor(state: 'down' | 'failing', since: Date, now: Date, subject?: string): string {
  const duration = formatDuration(now.getTime() - since.getTime());
  const verb = state === 'down' ? 'down' : 'failing';
  return subject ? `${subject} ${verb} for ${duration}` : `${verb[0]!.toUpperCase()}${verb.slice(1)} for ${duration}`;
}

export interface AlertOpenedInput {
  endpoint: EndpointRef;
  firstFailureAt: Date;
  /** The most recent deploy in the window before the first failure, if any. */
  deploy: { sha: string; deployedAt: Date } | null;
  /** MISSING variables new in that deploy vs. the previous scanned deploy. */
  newMissing: readonly string[];
  /**
   * Variables that deploy newly references in scopes with no env file (which have no MISSING
   * rows, so nothing declares them anywhere): `newUndeclaredVars`. Empty for older scans.
   */
  newUndeclared?: readonly string[];
}

/**
 * An alert lists every variable up to this many, and above it this many minus one, then "and N
 * more" (a first deploy with no previous scan counts every variable it reads as new). Counts stay
 * exact. Webhooks reuse the message, so they read the same.
 */
export const MAX_ALERT_NAMES = 6;

/** "A, B, C" for up to MAX_ALERT_NAMES names; above that "A, B, C, D, E and 35 more". */
export function listNames(names: readonly string[]): string {
  if (names.length <= MAX_ALERT_NAMES) return names.join(', ');
  const shown = names.slice(0, MAX_ALERT_NAMES - 1);
  return `${shown.join(', ')} and ${names.length - shown.length} more`;
}

export function alertOpenedMessage({ endpoint, firstFailureAt, deploy, newMissing, newUndeclared = [] }: AlertOpenedInput): string {
  const label = endpointLabel(endpoint);
  if (!deploy) {
    return `${label} started failing; no deploy in the ${DEPLOY_LINK_WINDOW_MINUTES} minutes before the first failure`;
  }
  const after = formatDuration(firstFailureAt.getTime() - deploy.deployedAt.getTime());
  const lead = `${label} started failing ${after} after deploy ${deploy.sha.slice(0, 7)}`;
  const parts: string[] = [];
  if (newMissing.length > 0) {
    parts.push(`${newMissing.length} ${newMissing.length === 1 ? 'missing env var' : 'missing env vars'}: ${listNames(newMissing)}`);
  }
  if (newUndeclared.length > 0) {
    const noun = newUndeclared.length === 1 ? 'new env var' : 'new env vars';
    parts.push(`${newUndeclared.length} ${noun} no env file declares: ${listNames(newUndeclared)}`);
  }
  if (parts.length === 0) return `${lead}, which had no new config findings`;
  return `${lead}, which introduced ${parts.join(', plus ')}`;
}

export function alertResolvedMessage({
  endpoint,
  openedAt,
  resolvedAt,
}: {
  endpoint: EndpointRef;
  openedAt: Date;
  resolvedAt: Date;
}): string {
  return `${endpointLabel(endpoint)} is back up (alert open for ${formatDuration(resolvedAt.getTime() - openedAt.getTime())})`;
}

/** Body of the Slack/Discord-compatible webhook: plain `{ text }`. */
export function webhookPayload(event: 'opened' | 'resolved', projectName: string, message: string): { text: string } {
  return { text: escapeChatText(`[${event === 'opened' ? 'down' : 'resolved'}] ${projectName}: ${message}`) };
}

/**
 * Text a chat webhook can't turn into markup or a mass mention: `&`, `<` and `>` as Slack's
 * entities (so `<!channel>`, `<@U…>` and links can't be formed), and a zero-width space after the
 * `@` of `@everyone`, `@here` and `@channel` (Discord pings on those). The fixed wording of alert
 * messages contains none of these, so only names (project, endpoint, variables) ever change.
 */
export function escapeChatText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@(everyone|here|channel)\b/gi, '@\u200b$1');
}

export type UptimeStatus = 'up' | 'degraded' | 'down' | 'no_endpoints';

/**
 * A project's uptime badge:
 * - no_endpoints: nothing enabled
 * - down: any enabled endpoint has an open alert
 * - degraded: no open alerts, but some enabled endpoint's latest check failed
 * - up: otherwise (endpoints without checks yet don't count against it)
 */
export function uptimeStatus(input: { enabledEndpoints: number; openAlerts: number; failingEndpoints: number }): UptimeStatus {
  if (input.enabledEndpoints === 0) return 'no_endpoints';
  if (input.openAlerts > 0) return 'down';
  if (input.failingEndpoints > 0) return 'degraded';
  return 'up';
}

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

/** How alerts and badges name an endpoint: its host, e.g. "api.acme.com". */
export function endpointLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
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
 * or "Failing for 1m" (not alerting yet). `since` is the first failed check of the current run.
 */
export function failingFor(state: 'down' | 'failing', since: Date, now: Date): string {
  return `${state === 'down' ? 'Down' : 'Failing'} for ${formatDuration(now.getTime() - since.getTime())}`;
}

export interface AlertOpenedInput {
  endpointUrl: string;
  firstFailureAt: Date;
  /** The most recent deploy in the window before the first failure, if any. */
  deploy: { sha: string; deployedAt: Date } | null;
  /** MISSING variables new in that deploy vs. the previous scanned deploy. */
  newMissing: readonly string[];
}

export function alertOpenedMessage({ endpointUrl, firstFailureAt, deploy, newMissing }: AlertOpenedInput): string {
  const label = endpointLabel(endpointUrl);
  if (!deploy) {
    return `${label} started failing; no deploy in the ${DEPLOY_LINK_WINDOW_MINUTES} minutes before the first failure`;
  }
  const after = formatDuration(firstFailureAt.getTime() - deploy.deployedAt.getTime());
  const lead = `${label} started failing ${after} after deploy ${deploy.sha.slice(0, 7)}`;
  if (newMissing.length === 0) return `${lead}, which had no new config findings`;
  const noun = newMissing.length === 1 ? 'missing env var' : 'missing env vars';
  return `${lead}, which introduced ${newMissing.length} ${noun}: ${newMissing.join(', ')}`;
}

export function alertResolvedMessage({
  endpointUrl,
  openedAt,
  resolvedAt,
}: {
  endpointUrl: string;
  openedAt: Date;
  resolvedAt: Date;
}): string {
  return `${endpointLabel(endpointUrl)} is back up (alert open for ${formatDuration(resolvedAt.getTime() - openedAt.getTime())})`;
}

/** Body of the Slack/Discord-compatible webhook: plain `{ text }`. */
export function webhookPayload(event: 'opened' | 'resolved', projectName: string, message: string): { text: string } {
  return { text: `[${event === 'opened' ? 'down' : 'resolved'}] ${projectName}: ${message}` };
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

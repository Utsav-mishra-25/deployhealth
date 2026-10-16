import * as Sentry from '@sentry/node';
import { scrubErrorEvent } from './redact';

/**
 * Error reporting to Sentry for web and worker (`@deployhealth/db/sentry`, like ./redact: shared
 * server code, no database), on only when SENTRY_DSN is set and parses. Errors only: no tracing,
 * no profiling, no breadcrumbs (they repeat log lines), no OpenTelemetry setup, no default PII,
 * and every event goes through scrubErrorEvent() (no request data, headers, cookies, query strings,
 * tokens, webhook URLs or env values) before it is sent. The SDK's own HTTPS transport talks only
 * to the DSN's host, which the operator sets: the one outbound request that doesn't go through
 * apps/worker/src/guarded-http.ts (docs/architecture/security.md).
 */

export interface SentrySettings {
  dsn: string | null;
  /** The commit SHA (Railway's RAILWAY_GIT_COMMIT_SHA), or null. */
  release: string | null;
  environment: string;
}

/** The DSN when it looks like one (http(s), a public key, a numeric project id), else null. */
export function parseDsn(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.username || !/^\/(?:.*\/)?\d+$/.test(url.pathname)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** A 7–40 character hex commit SHA (Railway's RAILWAY_GIT_COMMIT_SHA), lower-cased, else null. */
export function parseCommitSha(raw: string | null | undefined): string | null {
  const sha = raw?.trim().toLowerCase();
  return sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/** Sentry options for one server: `service` is `web` or `worker` (server_name and a tag). */
export function sentryOptions(settings: SentrySettings & { dsn: string }, service: string): Sentry.NodeOptions {
  return {
    dsn: settings.dsn,
    release: settings.release ?? undefined,
    environment: settings.environment,
    serverName: service,
    initialScope: { tags: { service } },
    sendDefaultPii: false,
    skipOpenTelemetrySetup: true,
    includeLocalVariables: false,
    maxBreadcrumbs: 0,
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
    ],
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubErrorEvent(event),
  };
}

/** Start Sentry when configured. Returns whether it's on; a DSN that doesn't parse is one error line. */
export function initSentry(settings: SentrySettings, service: string, log: (message: string) => void): boolean {
  if (!settings.dsn) return false;
  const dsn = parseDsn(settings.dsn);
  if (!dsn) {
    log('[sentry] SENTRY_DSN is not a Sentry DSN (https://<key>@<host>/<project id>); error reporting is off');
    return false;
  }
  Sentry.init(sentryOptions({ ...settings, dsn }, service));
  log(`[sentry] error reporting on${settings.release ? `, release ${settings.release.slice(0, 7)}` : ''}`);
  return true;
}

/** Report an error with tags (`queue`, …) when Sentry is on; does nothing otherwise. */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(error, { tags });
}

/** Wait (at most `ms`) for queued reports to be sent, e.g. before the process exits. */
export async function flushReports(ms = 2_000): Promise<void> {
  if (Sentry.isInitialized()) await Sentry.flush(ms);
}

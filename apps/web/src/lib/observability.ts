import type { Instrumentation } from 'next';
import { installConsoleRedaction } from '@deployhealth/db/redact';
import { initSentry, parseCommitSha, reportError } from '@deployhealth/db/sentry';
import { serverEnv } from '@/env';

/**
 * Started once from instrumentation.ts, in the Node.js runtime only: every console line is
 * redacted (Next's own error logs included), and errors go to Sentry when SENTRY_DSN is set. Server
 * side only: no browser SDK, nothing added to the client bundle or to any page.
 */
export function startObservability(): void {
  installConsoleRedaction();
  let env;
  try {
    env = serverEnv();
  } catch {
    return; // the first request reports an invalid environment (env.ts); no error reports until it's fixed
  }
  initSentry({ dsn: env.SENTRY_DSN ?? null, release: parseCommitSha(env.RAILWAY_GIT_COMMIT_SHA), environment: env.NODE_ENV }, 'web', (message) => console.log(message));
}

/**
 * Next's onRequestError: the error, tagged with the route's pattern (`/share/reports/[token]`,
 * never the path a request used, which can hold a share token) and the method. No headers, no
 * body, no query; the event is scrubbed again before sending (scrubErrorEvent).
 */
export const reportRequestError: Instrumentation.onRequestError = (error, request, context) => {
  reportError(error, { route: context.routePath, route_type: context.routeType, router: context.routerKind, method: request.method });
};

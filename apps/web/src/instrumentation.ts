import type { Instrumentation } from 'next';
import { isNodeRuntime } from '@/env';
import { reportPublicOriginProblem } from '@/lib/app-url';
import { reportStatusPageUrlProblem } from '@/lib/site-nav';

/**
 * Runs once when the server starts: one error if PUBLIC_ORIGIN is invalid, or missing in
 * production, and one if STATUS_PAGE_URL is set but unusable; then, in the Node.js runtime, redacted logs and optional error reports
 * (lib/observability.ts).
 */
export async function register(): Promise<void> {
  try {
    reportPublicOriginProblem();
    reportStatusPageUrlProblem();
  } catch {
    // An invalid environment is reported by the first request that reads it (env.ts), with every problem listed.
  }
  if (!isNodeRuntime()) return;
  const { startObservability } = await import('@/lib/observability');
  startObservability();
}

/** Every error a request hit (pages, route handlers, server actions, middleware), to Sentry when it's on. */
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (!isNodeRuntime()) return;
  const { reportRequestError } = await import('@/lib/observability');
  await reportRequestError(...args);
};

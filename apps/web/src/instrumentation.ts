import { isNodeRuntime } from '@/env';
import { reportPublicOriginProblem } from '@/lib/app-url';

/**
 * Runs once when the server starts: one error if PUBLIC_ORIGIN is invalid, or missing in
 * production; then, in the Node.js runtime, every console line is redacted from here on (Next's
 * own error logs included; @deployhealth/db/redact).
 */
export async function register(): Promise<void> {
  try {
    reportPublicOriginProblem();
  } catch {
    // An invalid environment is reported by the first request that reads it (env.ts), with every problem listed.
  }
  if (!isNodeRuntime()) return;
  const { installConsoleRedaction } = await import('@deployhealth/db/redact');
  installConsoleRedaction();
}

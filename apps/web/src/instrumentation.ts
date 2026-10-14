import { reportMissingPublicOrigin } from '@/lib/app-url';

/** Runs once when the server starts: says so right away if PUBLIC_ORIGIN is missing in production. */
export function register(): void {
  try {
    reportMissingPublicOrigin();
  } catch {
    // An invalid environment is reported by the first request that reads it (env.ts), with every problem listed.
  }
}

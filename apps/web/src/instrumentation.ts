import { reportPublicOriginProblem } from '@/lib/app-url';

/** Runs once when the server starts: says right away if PUBLIC_ORIGIN is invalid, or missing in production. */
export function register(): void {
  try {
    reportPublicOriginProblem();
  } catch {
    // An invalid environment is reported by the first request that reads it (env.ts), with every problem listed.
  }
}

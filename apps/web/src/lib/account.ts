import { createRateLimiter } from '@/lib/rate-limit';

// The account page (/account): "Export my data" and "Delete my account". The wording lives here so
// the page, the deleted page and the tests share it.

/** Where a session whose user no longer exists is sent: a route that signs it out (app/account/signed-out). */
export const SIGNED_OUT_PATH = '/account/signed-out';
/** Where the browser lands after its account is deleted (public: the session is gone). */
export const DELETED_PATH = '/account/deleted';
export const EXPORT_PATH = '/account/export';

/** What the export holds, in one sentence. */
export const EXPORT_DESCRIPTION =
  'A JSON file of everything deployhealth holds for you: your clients, projects, deploys, scan findings (variable names, files and line numbers), endpoints with their daily uptime totals, alerts, pull request checks and GitHub App installations. No tokens, no webhook URLs, never any env values (deployhealth never has them).';

/** What deleting an account means for the freelancer's clients and their GitHub accounts. */
export const DELETION_CONSEQUENCES = [
  "Monthly report links you've shared with clients stop working.",
  'Uptime checks and alerts stop for every endpoint.',
  'Pull request checks stop on every account and organization you installed the deployhealth GitHub App on. Uninstall it on GitHub (Settings → Applications → Installed GitHub Apps, and in each organization’s settings): deployhealth can’t remove it for you.',
  "Projects' ingest tokens stop working, so the GitHub Action's reports are refused.",
  'Signing in again later creates a new, empty account.',
] as const;

/** Whether the typed confirmation is the account's GitHub login (case and surrounding spaces don't matter). */
export function confirmationMatches(typed: unknown, login: string): boolean {
  return typeof typed === 'string' && typed.trim().toLowerCase() === login.toLowerCase();
}

/** `deployhealth-export-2026-10-16.json` (UTC date). */
export function exportFilename(now: Date): string {
  return `deployhealth-export-${now.toISOString().slice(0, 10)}.json`;
}

export const EXPORTS_PER_WINDOW = 5;
export const EXPORT_WINDOW_MS = 10 * 60_000;

// An export reads every row a user owns: at most 5 per user per 10 minutes, in memory per web
// process, like the other limits in lib/rate-limit.ts.
const exports = createRateLimiter({ limit: EXPORTS_PER_WINDOW, windowMs: EXPORT_WINDOW_MS });

/** Counts one export for the user; a message once over the limit, else null. */
export function exportRefusal(userId: string): string | null {
  const { ok, retryAfterSeconds } = exports.check(userId);
  if (ok) return null;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many exports: at most ${EXPORTS_PER_WINDOW} every ${EXPORT_WINDOW_MS / 60_000} minutes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

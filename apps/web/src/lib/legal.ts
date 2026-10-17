import { CHECK_RETENTION_DAYS } from '@deployhealth/core';
import { ACCOUNT_DELETION_RECORD_DAYS } from '@deployhealth/db';

/** The source repository, linked from the footer, /security, /terms and the landing page. */
export const REPO_URL = 'https://github.com/Utsav-mishra-25/deployhealth';

/** Who runs the hosted service at deployhealth.dev. Public information only. */
export const OPERATOR = { name: 'Utsav Mishra', country: 'India' } as const;

/** Shown as "Last updated" on /privacy and /terms. Change it with every change to either page. */
export const LEGAL_LAST_UPDATED = new Date('2026-10-17T00:00:00Z');

/** Where the hosted service and its database run. */
export const HOSTING = { provider: 'Railway', region: 'Singapore' } as const;

/** Every third party that processes data for the hosted service. */
export const SUBPROCESSORS = [
  { name: 'Railway', purpose: 'hosting and the database' },
  { name: 'Cloudflare', purpose: 'DNS and the proxy in front of the site' },
  { name: 'GitHub', purpose: 'sign-in, and the optional GitHub App for pull request checks' },
  { name: 'Sentry', purpose: 'error reports from the servers, scrubbed before they are sent (see Security)' },
] as const;

/** How soon an emailed deletion request is carried out. */
export const DELETION_REQUEST_DAYS = 30;

/**
 * What an error report holds and what is removed first, word for word the same on /security and
 * /privacy. True to packages/db/src/redact.ts (scrubErrorEvent, redactText) and sentry.ts.
 */
export const ERROR_REPORTS_TEXT =
  "When the servers hit an error, they send a report to Sentry: the error's type, its message and stack trace (files and lines in deployhealth's code), the release, and the route's pattern (such as /projects/[projectId], never the address you visited). Before it leaves the server, request bodies, headers, cookies, query strings, who was signed in, local variables and source lines are removed, and tokens, webhook URLs, email addresses, long random strings and anything shaped like NAME=value are replaced with [redacted]. Server logs are redacted the same way.";

/** Self-serve export and deletion on /account, for /privacy and /security. */
export const SELF_SERVE_DATA_TEXT =
  'On your Account page, "Export my data" downloads a JSON file of everything deployhealth holds for you (no tokens, no webhook URLs), and "Delete my account" deletes your account and everything it owns at once, after you type your GitHub login.';

/** What a deletion leaves behind, and for how long. */
export const DELETION_RECORD_TEXT = `A deletion leaves one record: your GitHub numeric id and the date, kept for ${ACCOUNT_DELETION_RECORD_DAYS} days so that restoring a backup can never bring the account back.`;

/** The retention rule for uptime checks, word for word the same on /security and /privacy. */
export const CHECK_RETENTION_TEXT = `Raw checks are deleted after ${CHECK_RETENTION_DAYS} days; daily totals are kept for monthly reports.`;

/** "30 September 2026" (UTC). */
export function formatLegalDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

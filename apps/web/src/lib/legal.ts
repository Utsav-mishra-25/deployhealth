import { CHECK_RETENTION_DAYS } from '@deployhealth/core';

/** The source repository, linked from the footer, /security, /terms and the landing page. */
export const REPO_URL = 'https://github.com/Utsav-mishra-25/deployhealth';

/** Who runs the hosted service at deployhealth.dev. Public information only. */
export const OPERATOR = { name: 'Utsav Mishra', country: 'India' } as const;

/** Shown as "Last updated" on /privacy and /terms. Change it with every change to either page. */
export const LEGAL_LAST_UPDATED = new Date('2026-09-30T00:00:00Z');

/** Where the hosted service and its database run. */
export const HOSTING = { provider: 'Railway', region: 'Singapore' } as const;

/** Every third party that processes data for the hosted service. */
export const SUBPROCESSORS = [
  { name: 'Railway', purpose: 'hosting and the database' },
  { name: 'Cloudflare', purpose: 'DNS and the proxy in front of the site' },
  { name: 'GitHub', purpose: 'sign-in, and the optional GitHub App for pull request checks' },
] as const;

/** How soon an emailed deletion request is carried out. */
export const DELETION_REQUEST_DAYS = 30;

/** The retention rule for uptime checks, word for word the same on /security and /privacy. */
export const CHECK_RETENTION_TEXT = `Raw checks are deleted after ${CHECK_RETENTION_DAYS} days; daily totals are kept for monthly reports.`;

/** "30 September 2026" (UTC). */
export function formatLegalDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

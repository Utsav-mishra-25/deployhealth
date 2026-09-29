import { serverEnv } from '@/env';

/** Where reports go when SECURITY_CONTACT_EMAIL is unset (the repository must allow private reporting). */
export const SECURITY_ADVISORY_URL = 'https://github.com/Utsav-mishra-25/deployhealth/security/advisories/new';

export interface SecurityContact {
  /** mailto: link, or the GitHub advisory form. */
  href: string;
  /** What the page shows. */
  label: string;
}

/** The email, else a private security advisory on GitHub. */
export function contactFor(email: string | undefined): SecurityContact {
  return email ? { href: `mailto:${email}`, label: email } : { href: SECURITY_ADVISORY_URL, label: 'a private security advisory on GitHub' };
}

/** From SECURITY_CONTACT_EMAIL. */
export function securityContact(): SecurityContact {
  return contactFor(serverEnv().SECURITY_CONTACT_EMAIL);
}

/** How long a served security.txt stays valid (RFC 9116 recommends under a year). */
export const SECURITY_TXT_DAYS = 180;

/** RFC 9116 /.well-known/security.txt. Expires is rounded to the UTC day. */
export function securityTxt({ baseUrl, contact, now }: { baseUrl: string; contact: SecurityContact; now: Date }): string {
  const expires = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + SECURITY_TXT_DAYS));
  return [
    `Contact: ${contact.href}`,
    `Expires: ${expires.toISOString()}`,
    'Preferred-Languages: en',
    `Canonical: ${baseUrl}/.well-known/security.txt`,
    `Policy: ${baseUrl}/security`,
    '',
  ].join('\n');
}

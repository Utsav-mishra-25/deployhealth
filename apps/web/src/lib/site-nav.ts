import { serverEnv } from '@/env';
import { REPO_URL } from './legal';

/**
 * Set by middleware.ts on /share/* requests: a client opening a shared report sees the logo only,
 * not the site's navigation. Forging it elsewhere only hides the nav for whoever sends it.
 */
export const HIDE_PUBLIC_NAV_HEADER = 'x-deployhealth-hide-nav';

/** The header's links for signed-out visitors, after the logo. Demo only when the demo is public. */
export function publicNavLinks(demo: boolean): { href: string; label: string }[] {
  return [...(demo ? [{ href: '/demo', label: 'Demo' }] : []), { href: '/docs', label: 'Docs' }, { href: '/pricing', label: 'Pricing' }];
}

export interface FooterLink {
  href: string;
  label: string;
  /** Off-site (a plain <a>, not next/link). */
  external?: true;
}

/**
 * The footer's links: Docs, Pricing, Security, Privacy, Terms, Status (when `status` is set) and
 * the source. On a shared report (`share`: /share/*, which a client opens) only Privacy and Terms.
 */
export function footerLinks({ share, status }: { share: boolean; status: string | null }): FooterLink[] {
  const legal: FooterLink[] = [
    { href: '/privacy', label: 'Privacy' },
    { href: '/terms', label: 'Terms' },
  ];
  if (share) return legal;
  return [
    { href: '/docs', label: 'Docs' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/security', label: 'Security' },
    ...legal,
    ...(status ? [{ href: status, label: 'Status', external: true as const }] : []),
    { href: REPO_URL, label: 'Source on GitHub', external: true },
  ];
}

/**
 * The footer's "Status" link: STATUS_PAGE_URL when it's an https URL (no credentials), else null
 * and the link is hidden. Read raw, so a bad value never fails a page.
 */
export function parseStatusPageUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function statusPageUrl(): string | null {
  return parseStatusPageUrl(serverEnv().STATUS_PAGE_URL);
}

/** At startup (instrumentation.ts): one error when STATUS_PAGE_URL is set but unusable. */
export function reportStatusPageUrlProblem(): void {
  const raw = serverEnv().STATUS_PAGE_URL;
  if (raw && parseStatusPageUrl(raw) === null) console.error('STATUS_PAGE_URL is not an https URL; the footer\'s Status link is hidden.');
}

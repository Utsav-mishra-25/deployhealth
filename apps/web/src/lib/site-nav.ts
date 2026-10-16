import { serverEnv } from '@/env';

/**
 * Set by middleware.ts on /share/* requests: a client opening a shared report sees the logo only,
 * not the site's navigation. Forging it elsewhere only hides the nav for whoever sends it.
 */
export const HIDE_PUBLIC_NAV_HEADER = 'x-deployhealth-hide-nav';

/** The header's links for signed-out visitors, after the logo. Demo only when the demo is public. */
export function publicNavLinks(demo: boolean): { href: string; label: string }[] {
  return [...(demo ? [{ href: '/demo', label: 'Demo' }] : []), { href: '/docs', label: 'Docs' }, { href: '/pricing', label: 'Pricing' }];
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

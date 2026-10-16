/**
 * Set by middleware.ts on /share/* requests: a client opening a shared report sees the logo only,
 * not the site's navigation. Forging it elsewhere only hides the nav for whoever sends it.
 */
export const HIDE_PUBLIC_NAV_HEADER = 'x-deployhealth-hide-nav';

/** The header's links for signed-out visitors, after the logo. Demo only when the demo is public. */
export function publicNavLinks(demo: boolean): { href: string; label: string }[] {
  return [...(demo ? [{ href: '/demo', label: 'Demo' }] : []), { href: '/docs', label: 'Docs' }, { href: '/pricing', label: 'Pricing' }];
}

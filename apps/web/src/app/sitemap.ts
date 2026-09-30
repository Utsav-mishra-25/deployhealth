import type { MetadataRoute } from 'next';
import { appUrl } from '@/lib/app-url';
import { isDemoPublic } from '@/lib/demo';

/** The public, indexable pages. (No robots route: Cloudflare manages robots.txt.) */
export const SITEMAP_PATHS = ['/', '/demo', '/security', '/privacy', '/terms'] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await appUrl();
  const demo = isDemoPublic();
  return SITEMAP_PATHS.filter((path) => demo || path !== '/demo').map((path) => ({ url: `${base}${path}` }));
}

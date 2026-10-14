import type { MetadataRoute } from 'next';
import { publicOrigin } from '@/lib/app-url';
import { isDemoPublic } from '@/lib/demo';
import { DOCS_SLUGS } from '@/lib/docs-pages';

/** The public, indexable pages. (No robots route: Cloudflare manages robots.txt.) */
export const SITEMAP_PATHS = ['/', '/demo', '/docs', ...DOCS_SLUGS.map((slug) => `/docs/${slug}` as const), '/security', '/privacy', '/terms'] as const;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await publicOrigin();
  const demo = isDemoPublic();
  return SITEMAP_PATHS.filter((path) => demo || path !== '/demo').map((path) => ({ url: `${base}${path}` }));
}

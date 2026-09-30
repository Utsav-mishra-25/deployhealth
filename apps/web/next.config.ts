import type { NextConfig } from 'next';

/**
 * The CLI bundle at /deployhealth-scan.mjs (CLI_BUNDLE_PATH in core) predates the npm package.
 * It's still served for existing workflows, marked deprecated (RFC 9745) since 2026-09-29, with a
 * link to the migration note. No Sunset header yet: removal is a later phase.
 */
export const CLI_BUNDLE_DEPRECATION = [
  { key: 'Deprecation', value: `@${Date.UTC(2026, 8, 29) / 1000}` },
  { key: 'Link', value: '<https://github.com/Utsav-mishra-25/deployhealth#deprecated-downloading-the-cli-from-your-instance>; rel="deprecation"' },
];

/**
 * Sent on every route (pages, route handlers, /api/*, static files). No HSTS here: it's set at
 * Cloudflare. No script/style CSP yet (Next's inline scripts need nonces); frame-ancestors only.
 */
export const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** Next's pattern for every path, including `/`. */
export const ALL_ROUTES = '/:path*';

const config: NextConfig = {
  // The workspace packages ship TypeScript source.
  transpilePackages: ['@deployhealth/core', '@deployhealth/db'],
  serverExternalPackages: ['pg', 'pg-boss'],
  // Lint runs once for the whole repo (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  async headers() {
    return [
      { source: ALL_ROUTES, headers: SECURITY_HEADERS },
      { source: '/deployhealth-scan.mjs', headers: CLI_BUNDLE_DEPRECATION },
    ];
  },
};

export default config;

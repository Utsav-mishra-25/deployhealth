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

const config: NextConfig = {
  // The workspace packages ship TypeScript source.
  transpilePackages: ['@deployhealth/core', '@deployhealth/db'],
  serverExternalPackages: ['pg'],
  // Lint runs once for the whole repo (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/deployhealth-scan.mjs', headers: CLI_BUNDLE_DEPRECATION }];
  },
};

export default config;

import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source.
  transpilePackages: ['@deployhealth/core', '@deployhealth/db'],
  serverExternalPackages: ['pg'],
  // Lint runs once for the whole repo (`pnpm lint`), not inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  poweredByHeader: false,
};

export default config;

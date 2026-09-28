import { defineConfig } from 'tsup';

/**
 * One self-contained file (zod bundled in, only Node built-ins imported). The web app serves it
 * at /deployhealth-scan.mjs so the GitHub Actions snippet can download it without npm.
 */
export default defineConfig({
  entry: { 'deployhealth-scan': 'src/bin.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
  // Downloaded on every CI run, so keep it small.
  minify: true,
});

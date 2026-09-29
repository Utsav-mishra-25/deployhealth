import { defineConfig } from 'tsup';

/**
 * One self-contained file (only Node built-ins imported). `build:npm` publishes it as the npm
 * package deployhealth-scan; the web app also still serves it at /deployhealth-scan.mjs
 * (deprecated) for workflows written before the npm package.
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

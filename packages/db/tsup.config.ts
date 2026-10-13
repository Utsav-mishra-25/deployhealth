import { defineConfig } from 'tsup';

// Only the operator commands are built, so they run in the deployed web container without dev
// dependencies such as tsx: Railway runs `node packages/db/dist/migrate.js` before each web
// deploy, `node packages/db/dist/delete-user.js` deletes an account on request, and
// `node packages/db/dist/stats.js` prints usage counts.
export default defineConfig({
  entry: { migrate: 'src/migrate.ts', 'delete-user': 'src/delete-user-cli.ts', stats: 'src/stats-cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
});

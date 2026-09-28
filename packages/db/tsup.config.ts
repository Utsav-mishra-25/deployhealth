import { defineConfig } from 'tsup';

// Only the migration runner is built: Railway runs `node packages/db/dist/migrate.js`
// before each web deploy, without needing dev dependencies such as tsx.
export default defineConfig({
  entry: ['src/migrate.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
});

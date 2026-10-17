import { defineConfig } from 'tsup';

export default defineConfig({
  // index.js, plus the pull request check's isolate (src/pr-check/isolate.ts loads it from next to index.js),
  // and the backup service's backup.js and the restore command's restore.js.
  entry: { index: 'src/index.ts', 'pr-check-isolate': 'src/pr-check/isolate-worker.ts', backup: 'src/backup-cli.ts', restore: 'src/restore-cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them; npm dependencies stay external.
  noExternal: [/^@deployhealth\//],
});

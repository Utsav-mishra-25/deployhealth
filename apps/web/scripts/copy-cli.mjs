// Serve the single-file CLI bundle at /deployhealth-scan.mjs for the GitHub Actions snippet.
// packages/core must be built first (pnpm builds workspace dependencies before this package).
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../../../packages/core/dist/deployhealth-scan.mjs', import.meta.url));
const to = fileURLToPath(new URL('../public/deployhealth-scan.mjs', import.meta.url));

if (!existsSync(from)) {
  console.error('copy-cli: packages/core/dist/deployhealth-scan.mjs is missing; run `pnpm --filter @deployhealth/core build`');
  process.exit(1);
}
copyFileSync(from, to);
console.log('copy-cli: public/deployhealth-scan.mjs updated');

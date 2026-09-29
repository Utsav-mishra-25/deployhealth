// Assemble packages/core/npm for `npm publish`: the CLI bundle tsup just built, plus core's MIT
// LICENSE. Run through `pnpm --filter @deployhealth/core build:npm`.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const core = new URL('../', import.meta.url);
const npm = new URL('npm/', core);
const bundle = new URL('dist/deployhealth-scan.mjs', core);
const target = new URL('dist/deployhealth-scan.mjs', npm);

if (!existsSync(bundle)) {
  console.error('pack-npm: dist/deployhealth-scan.mjs is missing; run tsup first');
  process.exit(1);
}

rmSync(new URL('dist/', npm), { recursive: true, force: true });
mkdirSync(new URL('dist/', npm), { recursive: true });
copyFileSync(bundle, target);
chmodSync(target, 0o755);
copyFileSync(new URL('LICENSE', core), new URL('LICENSE', npm));

// npx users see the bundle's --version, so it must match the version being published.
const { version } = JSON.parse(readFileSync(new URL('package.json', npm), 'utf8'));
const reported = execFileSync(process.execPath, [fileURLToPath(target), '--version'], { encoding: 'utf8' }).trim();
if (reported !== version) {
  console.error(`pack-npm: the bundle reports ${reported} but npm/package.json says ${version}; update src/version.ts`);
  process.exit(1);
}
console.log(`pack-npm: packages/core/npm is ready to publish deployhealth-scan@${version}`);

// `pnpm db:seed`: reseed the demo user. Kept out of seed.ts so importing the seed (the worker's
// reseed-demo job bundles it) never runs anything.
import { createDb } from './client';
import { DEMO_LOGIN } from './demo';
import { DEFAULT_DEMO_BASE_URL, DEMO_PROJECT, HISTORY_DAYS, seed } from './seed';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const baseUrl = process.env.DEMO_BASE_URL || DEFAULT_DEMO_BASE_URL;
const handle = createDb(url, { max: 1 });
try {
  const result = await seed(handle.db, new Date(), { baseUrl });
  console.log(`Seeded user "${DEMO_LOGIN}": 2 clients, 3 projects, 4 endpoints with ${HISTORY_DAYS} days of checks, 1 open alert.`);
  console.log(`The failing "Acme API" endpoint is ${baseUrl.replace(/\/$/, '')}/api/demo/broken.`);
  console.log(`Ingest token for ${DEMO_PROJECT.name} (shown once): ${result.token}`);
} finally {
  await handle.close();
}

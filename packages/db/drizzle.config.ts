import { defineConfig } from 'drizzle-kit';

// `generate` only diffs the schema against drizzle/meta, so no database is needed for it.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://deployhealth:deployhealth@localhost:5432/deployhealth' },
  strict: true,
});

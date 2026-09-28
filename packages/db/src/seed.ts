import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { generateToken, hashToken, tokenHint, type FindingRow } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { DEMO_GITHUB_ID, DEMO_LOGIN } from './demo';
import { createProject, recordScan, upsertGithubUser } from './queries';
import { users } from './schema';

export const DEMO_PROJECT = { name: 'acme-storefront', repoFullName: 'acme/storefront' } as const;
export const DEMO_DEPLOY_COUNT = 10;

/** A finding that is present from deploy `from` through deploy `to` (1-based, inclusive). */
interface Issue {
  from: number;
  to: number;
  finding: FindingRow;
}

const missing = (var_name: string, file: string, line: number): FindingRow => ({
  kind: 'missing',
  var_name,
  file,
  line,
  env_file: null,
});
const unused = (var_name: string, file: string, line: number): FindingRow => ({
  kind: 'unused',
  var_name,
  file,
  line,
  env_file: file,
});
const mismatch = (var_name: string, file: string, line: number, absentFrom: string): FindingRow => ({
  kind: 'mismatch',
  var_name,
  file,
  line,
  env_file: absentFrom,
});

/**
 * A storefront monorepo (apps/web, apps/api, apps/worker) over ten deploys: a Stripe webhook
 * secret goes missing and is fixed, Sentry breaks for one deploy, .env drifts from .env.example,
 * and some cleanup happens along the way.
 */
const ISSUES: Issue[] = [
  { from: 1, to: 10, finding: unused('OLD_PAYPAL_CLIENT_ID', 'apps/api/.env.example', 14) },
  { from: 1, to: 5, finding: unused('LEGACY_API_TOKEN', 'apps/api/.env.example', 17) },
  { from: 1, to: 8, finding: unused('FEATURE_GIFT_CARDS', 'apps/web/.env.example', 9) },
  { from: 1, to: 3, finding: missing('LOG_LEVEL', 'apps/api/src/lib/logger.ts', 5) },
  { from: 2, to: 4, finding: mismatch('NEXT_PUBLIC_SUPPORT_EMAIL', 'apps/web/.env.example', 6, 'apps/web/.env') },
  { from: 3, to: 6, finding: missing('REDIS_TLS_URL', 'apps/worker/app/queue.py', 22) },
  { from: 4, to: 5, finding: missing('STRIPE_WEBHOOK_SECRET', 'apps/api/src/billing/webhooks.ts', 12) },
  { from: 5, to: 5, finding: missing('STRIPE_WEBHOOK_SECRET', 'apps/api/src/billing/verify-signature.ts', 8) },
  { from: 6, to: 10, finding: mismatch('NEXT_PUBLIC_CHECKOUT_V2', 'apps/web/.env', 4, 'apps/web/.env.example') },
  { from: 7, to: 7, finding: missing('SENTRY_DSN', 'apps/web/src/instrumentation.ts', 7) },
  { from: 7, to: 7, finding: missing('SENTRY_DSN', 'apps/api/src/lib/sentry.ts', 3) },
  { from: 8, to: 10, finding: unused('S3_REGION', 'apps/worker/.env.example', 5) },
  { from: 9, to: 10, finding: missing('ANALYTICS_WRITE_KEY', 'apps/web/src/lib/analytics.ts', 4) },
  { from: 10, to: 10, finding: missing('SMTP_PASSWORD', 'apps/worker/app/jobs/send_receipts.py', 11) },
];

export interface SeedDeploy {
  sha: string;
  branch: string;
  deployedAt: Date;
  source: 'ingest' | 'manual';
  findings: FindingRow[];
}

/** The ten demo deploys, ending about an hour before `now`, roughly one a day. */
export function demoDeploys(now: Date): SeedDeploy[] {
  return Array.from({ length: DEMO_DEPLOY_COUNT }, (_, index) => {
    const n = index + 1;
    const hoursAgo = (DEMO_DEPLOY_COUNT - n) * 22 + 1 + (n % 3) * 2;
    return {
      sha: createHash('sha1').update(`acme-storefront-${n}`).digest('hex'),
      branch: n === 5 ? 'hotfix/stripe-webhook' : 'main',
      deployedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
      source: n === 7 ? 'manual' : 'ingest',
      findings: ISSUES.filter((i) => n >= i.from && n <= i.to).map((i) => i.finding),
    };
  });
}

export interface SeedResult {
  userId: string;
  projectId: string;
  /** Plaintext ingest token for the demo project. Only its hash is stored. */
  token: string;
}

/** Replace the demo user and everything it owns. Safe to run repeatedly. */
export async function seed(db: Db, now = new Date()): Promise<SeedResult> {
  await db.delete(users).where(eq(users.githubId, DEMO_GITHUB_ID));

  const user = await upsertGithubUser(db, {
    githubId: DEMO_GITHUB_ID,
    login: DEMO_LOGIN,
    name: 'Demo User',
    email: 'demo@example.com',
  });
  const token = generateToken();
  const project = await createProject(db, {
    ownerId: user.id,
    ...DEMO_PROJECT,
    apiTokenHash: hashToken(token),
    apiTokenHint: tokenHint(token),
  });

  for (const deploy of demoDeploys(now)) {
    await recordScan(db, { projectId: project.id, ...deploy });
  }
  return { userId: user.id, projectId: project.id, token };
}

// `pnpm db:seed`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const handle = createDb(url, { max: 1 });
  try {
    const result = await seed(handle.db);
    console.log(`Seeded user "${DEMO_LOGIN}" with project "${DEMO_PROJECT.name}" and ${DEMO_DEPLOY_COUNT} deploys.`);
    console.log(`Ingest token for ${DEMO_PROJECT.name} (shown once): ${result.token}`);
  } finally {
    await handle.close();
  }
}

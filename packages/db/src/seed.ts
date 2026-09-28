import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { generateToken, hashToken, tokenHint, type FindingRow } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { createClient } from './clients';
import { createDb, type Db } from './client';
import { DEMO_GITHUB_ID, DEMO_LOGIN } from './demo';
import { recordCheck, type CheckOutcome } from './monitoring';
import { createProject, recordScan, upsertGithubUser } from './queries';
import { checks, endpoints, users } from './schema';

export const DEMO_PROJECT = { name: 'acme-storefront', repoFullName: 'acme/storefront' } as const;
export const DEMO_DEPLOY_COUNT = 10;
export const HISTORY_DAYS = 7;

/** The scripted incident: the last storefront deploy, then failures this many minutes later. */
export const SCENARIO = {
  deployMinutesAgo: 26,
  failureAfterDeployMinutes: 4,
  endpointUrl: 'https://api.acme.example/health',
} as const;

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

/** A finding present from deploy `from` through deploy `to` (1-based, inclusive). */
interface Issue {
  from: number;
  to: number;
  finding: FindingRow;
}

const missing = (var_name: string, file: string, line: number): FindingRow => ({ kind: 'missing', var_name, file, line, env_file: null });
const unused = (var_name: string, file: string, line: number): FindingRow => ({ kind: 'unused', var_name, file, line, env_file: file });
const mismatch = (var_name: string, file: string, line: number, absentFrom: string): FindingRow => ({
  kind: 'mismatch',
  var_name,
  file,
  line,
  env_file: absentFrom,
});

/**
 * acme-storefront (apps/web, apps/api, apps/worker) over ten deploys: a Stripe webhook secret goes
 * missing and is fixed, Sentry breaks for one deploy, .env drifts from .env.example, and the last
 * deploy introduces REDIS_URL and STRIPE_KEY without defining them. That's the scripted incident.
 */
const STOREFRONT_ISSUES: Issue[] = [
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
  { from: 10, to: 10, finding: missing('REDIS_URL', 'apps/api/src/lib/cache.ts', 6) },
  { from: 10, to: 10, finding: missing('STRIPE_KEY', 'apps/api/src/billing/stripe.ts', 3) },
];

export interface SeedDeploy {
  sha: string;
  branch: string;
  deployedAt: Date;
  source: 'ingest' | 'manual';
  findings: FindingRow[];
}

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const hoursAgo = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000);

/** acme-storefront's ten deploys: roughly one a day, the last one 26 minutes before `now`. */
export function demoDeploys(now: Date): SeedDeploy[] {
  return Array.from({ length: DEMO_DEPLOY_COUNT }, (_, index) => {
    const n = index + 1;
    const deployedAt =
      n === DEMO_DEPLOY_COUNT
        ? new Date(now.getTime() - SCENARIO.deployMinutesAgo * 60_000)
        : hoursAgo(now, (DEMO_DEPLOY_COUNT - n) * 22 + 1 + (n % 3) * 2);
    return {
      sha: sha(`acme-storefront-${n}`),
      branch: n === 5 ? 'hotfix/stripe-webhook' : 'main',
      deployedAt,
      source: n === 7 ? 'manual' : 'ingest',
      findings: STOREFRONT_ISSUES.filter((i) => n >= i.from && n <= i.to).map((i) => i.finding),
    };
  });
}

function northwindDeploys(now: Date): SeedDeploy[] {
  const webhook = missing('SHOPIFY_WEBHOOK_SECRET', 'src/webhooks/orders.ts', 9);
  const sendgrid = unused('SENDGRID_API_KEY', '.env.example', 4);
  return [
    { sha: sha('northwind-1'), branch: 'main', deployedAt: hoursAgo(now, 150), source: 'ingest', findings: [webhook, sendgrid] },
    { sha: sha('northwind-2'), branch: 'main', deployedAt: hoursAgo(now, 90), source: 'ingest', findings: [sendgrid] },
    { sha: sha('northwind-3'), branch: 'main', deployedAt: hoursAgo(now, 26), source: 'ingest', findings: [sendgrid] },
  ];
}

function portfolioDeploys(now: Date): SeedDeploy[] {
  return [
    { sha: sha('portfolio-1'), branch: 'main', deployedAt: hoursAgo(now, 130), source: 'ingest', findings: [] },
    { sha: sha('portfolio-2'), branch: 'main', deployedAt: hoursAgo(now, 50), source: 'ingest', findings: [] },
  ];
}

// ---------------------------------------------------------------------------------------------
// Uptime history
// ---------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so every seed produces the same history. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface HistoryOptions {
  now: Date;
  intervalSeconds: number;
  baseLatencyMs: number;
  seed: number;
  /** Stop generating at this time (exclusive); later checks come from a scripted segment. */
  until?: Date;
  /** Indexes (from the start) of isolated single failures: blips that don't alert. */
  blipEvery?: number;
}

/**
 * Seven days of checks at a realistic latency: a daily curve peaking mid-afternoon UTC,
 * log-normal jitter, the odd slow spike, and occasional isolated 502s.
 */
function history({ now, intervalSeconds, baseLatencyMs, seed, until, blipEvery }: HistoryOptions): CheckOutcome[] {
  const rand = random(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  const out: CheckOutcome[] = [];
  const end = (until ?? now).getTime();
  const step = intervalSeconds * 1000;
  let i = 0;
  for (let t = now.getTime() - HISTORY_DAYS * 86_400_000 + step; t < end; t += step, i++) {
    const checkedAt = new Date(t + Math.floor(rand() * 3000));
    if (blipEvery && i > 0 && i % blipEvery === 0) {
      out.push({ checkedAt, statusCode: 502, latencyMs: Math.round(baseLatencyMs * 0.4), ok: false, error: 'Expected 200, got 502' });
      continue;
    }
    const hour = checkedAt.getUTCHours() + checkedAt.getUTCMinutes() / 60;
    const daily = 1 + 0.35 * Math.sin(((hour - 8) / 24) * 2 * Math.PI);
    const spike = rand() < 0.01 ? 3 + rand() * 4 : 1;
    const latencyMs = Math.max(5, Math.round(baseLatencyMs * daily * Math.exp(0.22 * gaussian()) * spike));
    out.push({ checkedAt, statusCode: 200, latencyMs, ok: true, error: null });
  }
  return out;
}

async function insertChecks(db: Db, endpointId: string, outcomes: CheckOutcome[]): Promise<void> {
  for (let i = 0; i < outcomes.length; i += 1000) {
    await db.insert(checks).values(outcomes.slice(i, i + 1000).map((o) => ({ endpointId, ...o })));
  }
}

/** Replay checks through the real recordCheck(), so alerts come from the production logic. */
async function replayChecks(db: Db, endpointId: string, outcomes: CheckOutcome[]): Promise<void> {
  for (const outcome of outcomes) await recordCheck(db, endpointId, outcome);
}

async function finishEndpoint(db: Db, endpointId: string, outcomes: CheckOutcome[], intervalSeconds: number): Promise<void> {
  let trailing = 0;
  for (let i = outcomes.length - 1; i >= 0 && !outcomes[i]!.ok; i--) trailing++;
  const last = outcomes[outcomes.length - 1]!.checkedAt;
  await db
    .update(endpoints)
    .set({ consecutiveFailures: trailing, nextCheckAt: new Date(last.getTime() + intervalSeconds * 1000) })
    .where(eq(endpoints.id, endpointId));
}

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------

export interface SeedResult {
  userId: string;
  /** acme-storefront, the project with the scripted incident. */
  projectId: string;
  /** Plaintext ingest token for acme-storefront. Only its hash is stored. */
  token: string;
}

/**
 * Replace the demo user and everything it owns (clients, projects, endpoints, checks, alerts)
 * with two clients, three projects (one unassigned), endpoints with 7 days of checks, one past
 * incident and one open alert linked to the deploy that caused it. Safe to run repeatedly.
 *
 * Healthy endpoints point at example.com/.org/.net, which really answer 200, so a running worker
 * keeps them up; the failing one uses api.acme.example, which never resolves, so it stays down.
 */
export async function seed(db: Db, now = new Date()): Promise<SeedResult> {
  await db.delete(users).where(eq(users.githubId, DEMO_GITHUB_ID));
  const user = await upsertGithubUser(db, { githubId: DEMO_GITHUB_ID, login: DEMO_LOGIN, name: 'Demo User', email: 'demo@example.com' });

  const acme = await createClient(db, user.id, {
    name: 'Acme Corp',
    contactEmail: 'ops@acme.example',
    notes: 'Monthly retainer. Storefront + API on Railway, DNS at Cloudflare.\nDeploys go out from main; hotfix branches for urgent billing fixes.',
  });
  const northwind = await createClient(db, user.id, {
    name: 'Northwind Bakery',
    contactEmail: 'hello@northwindbakery.example',
    notes: 'Marketing site and order API. Traffic peaks on weekend mornings.',
  });

  const newProject = async (name: string, repoFullName: string, clientId: string | null) => {
    const token = generateToken();
    const project = await createProject(db, { ownerId: user.id, name, repoFullName, clientId, apiTokenHash: hashToken(token), apiTokenHint: tokenHint(token) });
    return { project, token };
  };
  const { project: storefront, token } = await newProject(DEMO_PROJECT.name, DEMO_PROJECT.repoFullName, acme.id);
  const { project: northwindSite } = await newProject('northwind-site', 'northwind/site', northwind.id);
  const { project: portfolio } = await newProject('portfolio', 'demo/portfolio', null);

  for (const d of demoDeploys(now)) await recordScan(db, { projectId: storefront.id, ...d });
  for (const d of northwindDeploys(now)) await recordScan(db, { projectId: northwindSite.id, ...d });
  for (const d of portfolioDeploys(now)) await recordScan(db, { projectId: portfolio.id, ...d });

  const [api, homepage, bakery, folio] = await db
    .insert(endpoints)
    .values([
      { projectId: storefront.id, url: SCENARIO.endpointUrl, method: 'GET', intervalSeconds: 60 },
      { projectId: storefront.id, url: 'https://example.com/', method: 'HEAD', intervalSeconds: 300 },
      { projectId: northwindSite.id, url: 'https://example.org/', method: 'GET', intervalSeconds: 300 },
      { projectId: portfolio.id, url: 'https://example.net/', method: 'GET', intervalSeconds: 900 },
    ])
    .returning();

  // Scripted incident: healthy until 4 minutes after the last deploy, failing ever since.
  const deployedAt = new Date(now.getTime() - SCENARIO.deployMinutesAgo * 60_000);
  const firstFailure = new Date(deployedAt.getTime() + SCENARIO.failureAfterDeployMinutes * 60_000);
  const apiHealthy = history({ now, intervalSeconds: 60, baseLatencyMs: 85, seed: 1, until: firstFailure, blipEvery: 2_900 });
  const apiFailing: CheckOutcome[] = [];
  for (let t = firstFailure.getTime(); t <= now.getTime() - 5_000; t += 60_000) {
    apiFailing.push({ checkedAt: new Date(t), statusCode: 503, latencyMs: 38, ok: false, error: 'Expected 200, got 503' });
  }
  await insertChecks(db, api!.id, apiHealthy);
  await replayChecks(db, api!.id, apiFailing);
  await finishEndpoint(db, api!.id, [...apiHealthy, ...apiFailing], 60);

  const homepageChecks = history({ now, intervalSeconds: 300, baseLatencyMs: 140, seed: 2, blipEvery: 700 });
  await insertChecks(db, homepage!.id, homepageChecks);
  await finishEndpoint(db, homepage!.id, homepageChecks, 300);

  // A past incident on northwind, ~3 days ago, with no deploy nearby: opened and resolved.
  const bakeryChecks = history({ now, intervalSeconds: 300, baseLatencyMs: 210, seed: 3 });
  const incidentStart = bakeryChecks.findIndex((c) => c.checkedAt.getTime() >= now.getTime() - 3 * 86_400_000);
  const incident = bakeryChecks.slice(incidentStart, incidentStart + 4).map((c, i) =>
    i < 3 ? { ...c, statusCode: null, latencyMs: null, ok: false, error: 'Timed out after 10s' } : c,
  );
  await insertChecks(db, bakery!.id, bakeryChecks.slice(0, incidentStart));
  await replayChecks(db, bakery!.id, incident);
  await insertChecks(db, bakery!.id, bakeryChecks.slice(incidentStart + 4));
  await finishEndpoint(db, bakery!.id, bakeryChecks, 300);

  const folioChecks = history({ now, intervalSeconds: 900, baseLatencyMs: 60, seed: 4 });
  await insertChecks(db, folio!.id, folioChecks);
  await finishEndpoint(db, folio!.id, folioChecks, 900);

  return { userId: user.id, projectId: storefront.id, token };
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
    console.log(`Seeded user "${DEMO_LOGIN}": 2 clients, 3 projects, 4 endpoints with ${HISTORY_DAYS} days of checks, 1 open alert.`);
    console.log(`Ingest token for ${DEMO_PROJECT.name} (shown once): ${result.token}`);
  } finally {
    await handle.close();
  }
}

import { createHash } from 'node:crypto';
import { generateToken, hashToken, tokenHint, type EnvFileBasename, type FindingRow, type RequiredVariable } from '@deployhealth/core';
import { eq } from 'drizzle-orm';
import { createClient } from './clients';
import type { Db } from './client';
import { DEMO_ENDPOINT_IDS, DEMO_GITHUB_ID, DEMO_INSTALLATION_ID, DEMO_LOGIN, DEMO_PROJECT_IDS } from './demo';
import { recordCheck, type CheckOutcome } from './monitoring';
import { createProject, recordScan, upsertGithubUser } from './queries';
import { checks, clients, endpoints, installationRepos, installations, prChecks, projects, type NewPrCheck, type Project } from './schema';

export const DEMO_PROJECT = { name: 'acme-storefront', repoFullName: 'acme/storefront' } as const;
export const DEMO_DEPLOY_COUNT = 10;
export const HISTORY_DAYS = 7;

/**
 * The scripted incident: the last storefront deploy, then failures this many minutes later. The
 * worker reseeds every RESEED_INTERVAL_MINUTES (apps/worker/src/schedules.ts), so a visitor sees the
 * deploy between deployMinutesAgo and deployMinutesAgo + that interval old: always inside
 * DEMO_FRESHNESS.
 */
export const SCENARIO = {
  deployMinutesAgo: 12,
  failureAfterDeployMinutes: 4,
  endpointName: 'Acme API',
} as const;

/**
 * What "fresh" means for the demo at any moment: the incident's deploy is between these many
 * minutes old, and Acme API has been down for less than `maxDownMinutes`. Tested against the seed
 * and against the worker's reseed schedule.
 */
export const DEMO_FRESHNESS = { minDeployAgeMinutes: 10, maxDeployAgeMinutes: 45, maxDownMinutes: 60 } as const;

/** Served by the web app when DEMO_PUBLIC=1: always 503, so the demo alert is real and stays open. */
export const DEMO_BROKEN_PATH = '/api/demo/broken';

/** Where the local seed points the failing endpoint when no base URL is given. */
export const DEFAULT_DEMO_BASE_URL = 'http://localhost:3000';

/** The failing demo endpoint for a deployment at `baseUrl` (its public URL, e.g. the Railway domain). */
export function demoBrokenUrl(baseUrl: string): string {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error(`DEMO_BASE_URL must be http(s): ${baseUrl}`);
  return new URL(DEMO_BROKEN_PATH, base).href;
}

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
  variables: RequiredVariable[];
}

/** A variable the code references in `scope` from deploy `from` on (1-based). */
interface DemoVariable {
  scope: string;
  name: string;
  definedIn: EnvFileBasename[];
  from?: number;
}

/** What acme-storefront's code references, per env scope. */
const STOREFRONT_VARIABLES: DemoVariable[] = [
  { scope: 'apps/api', name: 'DATABASE_URL', definedIn: ['.env.example', '.env'] },
  { scope: 'apps/api', name: 'JWT_SECRET', definedIn: ['.env.example', '.env'] },
  { scope: 'apps/api', name: 'PORT', definedIn: ['.env.example'] },
  { scope: 'apps/api', name: 'LOG_LEVEL', definedIn: ['.env.example', '.env'] },
  { scope: 'apps/api', name: 'SENTRY_DSN', definedIn: ['.env.example', '.env'] },
  { scope: 'apps/api', name: 'STRIPE_WEBHOOK_SECRET', definedIn: ['.env.example', '.env'], from: 4 },
  { scope: 'apps/api', name: 'REDIS_URL', definedIn: ['.env.example'], from: 10 },
  { scope: 'apps/api', name: 'STRIPE_KEY', definedIn: ['.env.example'], from: 10 },
  { scope: 'apps/web', name: 'NEXT_PUBLIC_API_URL', definedIn: ['.env.example', '.env'] },
  { scope: 'apps/web', name: 'NEXT_PUBLIC_SUPPORT_EMAIL', definedIn: ['.env.example', '.env'], from: 2 },
  { scope: 'apps/web', name: 'NEXT_PUBLIC_CHECKOUT_V2', definedIn: ['.env'], from: 6 },
  { scope: 'apps/web', name: 'SENTRY_DSN', definedIn: ['.env.example', '.env'] },
  { scope: 'apps/web', name: 'ANALYTICS_WRITE_KEY', definedIn: ['.env.example'], from: 9 },
  { scope: 'apps/worker', name: 'DATABASE_URL', definedIn: ['.env.example', '.env'] },
  { scope: 'apps/worker', name: 'REDIS_TLS_URL', definedIn: ['.env.example'], from: 3 },
  { scope: 'apps/worker', name: 'S3_BUCKET', definedIn: ['.env.example'] },
];

/** The env scope a file belongs to in the demo repos: `apps/<name>` or the root. */
const scopeOf = (file: string | null) => /^apps\/[^/]+/.exec(file ?? '')?.[0] ?? '';

/**
 * Deploy `n`'s variable list: everything referenced by then, undefined wherever that deploy has
 * a MISSING finding for it. So the variables and the findings of every seeded scan agree.
 */
function variablesAt(n: number, list: DemoVariable[], findings: FindingRow[]): RequiredVariable[] {
  const missing = new Set(findings.filter((f) => f.kind === 'missing').map((f) => `${scopeOf(f.file)}:${f.var_name}`));
  return list
    .filter((v) => n >= (v.from ?? 1))
    .map((v) => ({ var_name: v.name, scope: v.scope, defined_in: missing.has(`${v.scope}:${v.name}`) ? [] : v.definedIn }));
}

const STOREFRONT_DEPLOY_NOTES = `## Where it runs

- **Web and API:** Railway project \`acme-prod\`, services \`web\` and \`api\`.
- **Worker:** Railway service \`worker\` (queues on Redis).
- **DNS:** Cloudflare; \`acme.example\` points at Railway.

## Deploying

1. Merge to \`main\`. Railway builds and deploys \`web\`, \`api\` and \`worker\`.
2. Database migrations run in the API's pre-deploy step (\`pnpm db:migrate\`).
3. Urgent billing fixes: branch \`hotfix/<name>\` from \`main\`, open a PR, merge.

## Secrets

Set per service in Railway, under **Variables**. The names are listed in *Required environment
variables* above; the values are in the client's 1Password vault **Acme / Production**.

## Rolling back

Railway → service → **Deployments** → redeploy the previous build. See the
[Railway deployment docs](https://docs.railway.com/guides/deployments).`;

const NORTHWIND_DEPLOY_NOTES = `Static marketing site plus a small order API, both on Railway (\`northwind\` project).

1. Push to \`main\`; Railway deploys it.
2. Shopify webhooks point at \`/webhooks/orders\`. After rotating \`SHOPIFY_WEBHOOK_SECRET\`, update it in Shopify **and** Railway.`;

const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const hoursAgo = (now: Date, hours: number) => new Date(now.getTime() - hours * 3_600_000);

/** acme-storefront's ten deploys: roughly one a day, the last one SCENARIO.deployMinutesAgo before `now`. */
export function demoDeploys(now: Date): SeedDeploy[] {
  return Array.from({ length: DEMO_DEPLOY_COUNT }, (_, index): SeedDeploy => {
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
      variables: [],
    };
  }).map((d, index) => ({ ...d, variables: variablesAt(index + 1, STOREFRONT_VARIABLES, d.findings) }));
}

function northwindDeploys(now: Date): SeedDeploy[] {
  const webhook = missing('SHOPIFY_WEBHOOK_SECRET', 'src/webhooks/orders.ts', 9);
  const sendgrid = unused('SENDGRID_API_KEY', '.env.example', 4);
  const list: DemoVariable[] = [
    { scope: '', name: 'DATABASE_URL', definedIn: ['.env.example', '.env'] },
    { scope: '', name: 'SHOPIFY_STORE_DOMAIN', definedIn: ['.env.example', '.env'] },
    { scope: '', name: 'SHOPIFY_WEBHOOK_SECRET', definedIn: ['.env.example'] },
  ];
  const deploy = (n: number, deployedAt: Date, findings: FindingRow[]): SeedDeploy => ({
    sha: sha(`northwind-${n}`),
    branch: 'main',
    deployedAt,
    source: 'ingest',
    findings,
    variables: variablesAt(n, list, findings),
  });
  return [deploy(1, hoursAgo(now, 150), [webhook, sendgrid]), deploy(2, hoursAgo(now, 90), [sendgrid]), deploy(3, hoursAgo(now, 26), [sendgrid])];
}

function portfolioDeploys(now: Date): SeedDeploy[] {
  const variables: RequiredVariable[] = [
    { var_name: 'CONTACT_FORM_ENDPOINT', scope: '', defined_in: ['.env.example'] },
    { var_name: 'NEXT_PUBLIC_SITE_URL', scope: '', defined_in: ['.env.example'] },
  ];
  return [
    { sha: sha('portfolio-1'), branch: 'main', deployedAt: hoursAgo(now, 130), source: 'ingest', findings: [], variables },
    { sha: sha('portfolio-2'), branch: 'main', deployedAt: hoursAgo(now, 50), source: 'ingest', findings: [], variables },
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

export interface SeedOptions {
  /** Public URL of the web app; the failing endpoint is `<baseUrl>/api/demo/broken`. */
  baseUrl?: string;
}

export interface SeedResult {
  userId: string;
  /** acme-storefront, the project with the scripted incident. */
  projectId: string;
  /** Plaintext ingest token for acme-storefront. Only its hash is stored. */
  token: string;
}

/**
 * Replace everything the demo user owns (clients, projects, endpoints, checks, alerts, pull
 * request checks) with two clients, three projects (one unassigned), endpoints with 7 days of
 * checks, one past incident and one open alert linked to the deploy that caused it. Safe to run
 * repeatedly, and atomic: it runs in one transaction, so a visitor to /demo never sees a
 * half-built demo.
 *
 * The demo user row itself is kept (upserted), and projects and endpoints have fixed ids, so a
 * request that read ids before a reseed commits still finds the same user, projects and endpoints
 * after it: /demo never renders empty or 404s because a reseed landed mid-request.
 *
 * Healthy endpoints point at example.com/.org, which really answer 200, so a running worker keeps
 * them up. "Acme API" points at the web app's /api/demo/broken, which always answers 503, so the
 * scripted alert stays open. (Locally the worker's SSRF guard blocks localhost; the failures are
 * replayed here either way, so the alert exists without a worker.)
 */
export async function seed(db: Db, now = new Date(), options: SeedOptions = {}): Promise<SeedResult> {
  const brokenUrl = demoBrokenUrl(options.baseUrl ?? DEFAULT_DEMO_BASE_URL);
  return db.transaction((tx) => seedDemo(tx, now, brokenUrl));
}

async function seedDemo(db: Db, now: Date, brokenUrl: string): Promise<SeedResult> {
  const user = await upsertGithubUser(db, { githubId: DEMO_GITHUB_ID, login: DEMO_LOGIN, name: 'Demo User', email: 'demo@example.com' });
  // Everything else the demo user owns hangs off its projects and clients (on delete cascade).
  await db.delete(projects).where(eq(projects.ownerId, user.id));
  await db.delete(clients).where(eq(clients.userId, user.id));

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

  const newProject = async (id: string, name: string, repoFullName: string, clientId: string | null) => {
    const token = generateToken();
    const project = await createProject(db, {
      id,
      ownerId: user.id,
      name,
      repoFullName,
      clientId,
      apiTokenHash: hashToken(token),
      apiTokenHint: tokenHint(token),
    });
    return { project, token };
  };
  const { project: storefront, token } = await newProject(DEMO_PROJECT_IDS.storefront, DEMO_PROJECT.name, DEMO_PROJECT.repoFullName, acme.id);
  const { project: northwindSite } = await newProject(DEMO_PROJECT_IDS.northwind, 'northwind-site', 'northwind/site', northwind.id);
  const { project: portfolio } = await newProject(DEMO_PROJECT_IDS.portfolio, 'portfolio', 'demo/portfolio', null);

  await db.update(projects).set({ deployNotes: STOREFRONT_DEPLOY_NOTES }).where(eq(projects.id, storefront.id));
  await db.update(projects).set({ deployNotes: NORTHWIND_DEPLOY_NOTES }).where(eq(projects.id, northwindSite.id));

  for (const d of demoDeploys(now)) await recordScan(db, { projectId: storefront.id, ...d });
  for (const d of northwindDeploys(now)) await recordScan(db, { projectId: northwindSite.id, ...d });
  for (const d of portfolioDeploys(now)) await recordScan(db, { projectId: portfolio.id, ...d });

  const [api, homepage, bakery, folio] = await db
    .insert(endpoints)
    .values([
      { id: DEMO_ENDPOINT_IDS.acmeApi, projectId: storefront.id, name: SCENARIO.endpointName, url: brokenUrl, method: 'GET', intervalSeconds: 60 },
      { id: DEMO_ENDPOINT_IDS.acmeStorefront, projectId: storefront.id, name: 'Acme storefront', url: 'https://example.com/', method: 'HEAD', intervalSeconds: 300 },
      { id: DEMO_ENDPOINT_IDS.northwind, projectId: northwindSite.id, name: 'Northwind site', url: 'https://example.org/', method: 'GET', intervalSeconds: 300 },
      // Unnamed on purpose: shows the fallback to the host ("example.net").
      { id: DEMO_ENDPOINT_IDS.portfolio, projectId: portfolio.id, url: 'https://example.net/', method: 'GET', intervalSeconds: 900 },
    ])
    .returning();

  // Scripted incident: healthy until 4 minutes after the last deploy, failing ever since.
  const deployedAt = new Date(now.getTime() - SCENARIO.deployMinutesAgo * 60_000);
  const firstFailure = new Date(deployedAt.getTime() + SCENARIO.failureAfterDeployMinutes * 60_000);
  const apiHealthy = history({ now, intervalSeconds: 60, baseLatencyMs: 85, seed: 1, until: firstFailure, blipEvery: 2_900 });
  const apiFailing: CheckOutcome[] = [];
  const failRand = random(5);
  for (let t = firstFailure.getTime(); t <= now.getTime() - 5_000; t += 60_000) {
    const latencyMs = 25 + Math.round(failRand() * 30);
    apiFailing.push({ checkedAt: new Date(t), statusCode: 503, latencyMs, ok: false, error: 'Expected 200, got 503' });
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

  await seedPullRequests(db, now, user.id, storefront, northwindSite);

  return { userId: user.id, projectId: storefront.id, token };
}

/**
 * The GitHub App side of the demo: an installation on the storefront and northwind repos, and a
 * few checked pull requests, two of them by coding agents that added undeclared env vars.
 */
async function seedPullRequests(db: Db, now: Date, userId: string, storefront: Project, northwind: Project): Promise<void> {
  // Installations aren't owned by the user row (it only links them), so clear the old one here.
  await db.delete(installations).where(eq(installations.githubInstallationId, DEMO_INSTALLATION_ID));
  const [installation] = await db
    .insert(installations)
    .values({ githubInstallationId: DEMO_INSTALLATION_ID, accountLogin: 'acme-corp', accountType: 'Organization', installerGithubId: DEMO_GITHUB_ID, userId })
    .returning();
  await db.insert(installationRepos).values([storefront, northwind].map((p) => ({ installationId: installation!.id, repoFullName: p.repoFullName })));

  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const common = (projectId: string, prNumber: number, hours: number) => ({
    projectId,
    installationId: installation!.id,
    prNumber,
    headSha: sha(`pr-${prNumber}-head`),
    baseSha: sha(`pr-${prNumber}-base`),
    createdAt: hoursAgo(hours),
    updatedAt: hoursAgo(hours),
  });
  const rows: NewPrCheck[] = [
    {
      ...common(storefront.id, 87, 3),
      authorLogin: 'claude[bot]',
      authorIsAgent: true,
      agentName: 'Claude',
      addedVars: [
        { name: 'CACHE_TTL', refs: [{ file: 'src/lib/cache.ts', line: 12 }, { file: 'src/lib/cache.ts', line: 31 }], total: 2, declared: false },
        { name: 'REDIS_URL', refs: [{ file: 'src/lib/cache.ts', line: 8 }], total: 1, declared: true },
      ],
      undeclaredVars: ['CACHE_TTL'],
      conclusion: 'neutral',
    },
    {
      ...common(storefront.id, 86, 26),
      authorLogin: 'Copilot',
      authorIsAgent: true,
      agentName: 'Copilot',
      renamedVars: [{ from: 'MAILER_KEY', to: 'MAIL_API_KEY', file: 'src/lib/mail.ts', line: 4, declared: true }],
      conclusion: 'success',
      closedAt: hoursAgo(20),
    },
    {
      ...common(storefront.id, 85, 48),
      authorLogin: 'maya-lopez',
      removedVars: [{ name: 'LEGACY_CHECKOUT', refs: [{ file: 'src/checkout/index.ts', line: 30 }], total: 1 }],
      conclusion: 'success',
      closedAt: hoursAgo(40),
    },
    {
      ...common(northwind.id, 12, 5),
      authorLogin: 'devin-ai-integration[bot]',
      authorIsAgent: true,
      agentName: 'Devin',
      addedVars: [{ name: 'ORDER_WEBHOOK_SECRET', refs: [{ file: 'api/orders.py', line: 18 }], total: 1, declared: false }],
      undeclaredVars: ['ORDER_WEBHOOK_SECRET'],
      committedEnvFiles: [{ path: '.env.local', added: true }],
      conclusion: 'neutral',
    },
  ];
  await db.insert(prChecks).values(rows);
}

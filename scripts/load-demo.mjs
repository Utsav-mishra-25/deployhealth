// Load sanity check of the public pages (manual; not run in CI).
//
//   pnpm load:demo                                   # build web, `next start` on :3200, measure, stop
//   pnpm load:demo --no-build                        # reuse the last `next build`
//   pnpm load:demo --url http://localhost:3000       # measure a server that's already running
//   pnpm load:demo --connections 20 --seconds 30     # the defaults
//
// The server reads its env as usual (apps/web/.env.local, or the shell's): it needs a seeded
// database (`pnpm db:seed`) and DEMO_PUBLIC=1. Each route gets N connections for S seconds, one
// route at a time, after one warm-up request. Latency is measured until the whole body has
// arrived; an error is a non-2xx answer or a failed request. (autocannon's JSON has no p95, so
// this measures itself with Node's fetch, which keeps connections alive.)
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const WEB = join(ROOT, 'apps/web');

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    port: { type: 'string', default: '3200' },
    build: { type: 'boolean', default: true },
    connections: { type: 'string', default: '20' },
    seconds: { type: 'string', default: '30' },
  },
  allowNegative: true,
});

const connections = Number(values.connections);
const seconds = Number(values.seconds);

// The demo's acme-storefront project has a fixed id (packages/db/src/demo.ts), so its links survive reseeds.
const demoIds = readFileSync(join(ROOT, 'packages/db/src/demo.ts'), 'utf8');
const storefront = /storefront:\s*'([0-9a-f-]{36})'/.exec(demoIds)?.[1];
if (!storefront) throw new Error('DEMO_PROJECT_IDS.storefront not found in packages/db/src/demo.ts');

const ROUTES = [
  { name: 'landing', path: '/' },
  { name: 'demo overview', path: '/demo' },
  { name: 'demo project (acme-storefront)', path: `/demo/projects/${storefront}` },
  { name: 'demo handoff (acme-storefront)', path: `/demo/projects/${storefront}/handoff` },
  { name: 'security', path: '/security' },
];

let server = null;
const base = values.url ?? `http://localhost:${values.port}`;

try {
  if (!values.url) {
    if (values.build) run('pnpm', ['--filter', '@deployhealth/web...', 'build']);
    server = spawn(join(WEB, 'node_modules/.bin/next'), ['start', '-p', values.port], { cwd: WEB, stdio: ['ignore', 'ignore', 'inherit'] });
    await waitForHealth();
  }
  const rows = [];
  for (const route of ROUTES) {
    const warm = await fetch(base + route.path);
    await warm.arrayBuffer();
    if (!warm.ok) throw new Error(`${route.path} answered ${warm.status}: is the demo seeded and DEMO_PUBLIC=1?`);
    process.stderr.write(`${route.name}: ${connections} connections for ${seconds}s…\n`);
    rows.push({ ...route, ...(await measure(base + route.path)) });
  }
  console.log(`\n${connections} connections, ${seconds} s per route, against ${base}\n`);
  console.log('| Route | Requests | rps | p50 | p95 | Errors |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of rows) console.log(`| ${r.name} \`${r.path}\` | ${r.requests} | ${r.rps.toFixed(0)} | ${r.p50} ms | ${r.p95} ms | ${r.errors} |`);
} finally {
  server?.kill('SIGTERM');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`next start did not answer ${base}/api/health within 60 s`);
}

async function measure(url) {
  const latencies = [];
  let errors = 0;
  const started = performance.now();
  const until = started + seconds * 1000;
  const worker = async () => {
    while (performance.now() < until) {
      const t = performance.now();
      try {
        const response = await fetch(url);
        await response.arrayBuffer();
        if (!response.ok) errors++;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - t);
    }
  };
  await Promise.all(Array.from({ length: connections }, worker));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p) => Math.round(latencies[Math.max(0, Math.ceil(p * latencies.length) - 1)] ?? 0);
  return { requests: latencies.length, rps: latencies.length / elapsed, p50: pct(0.5), p95: pct(0.95), errors };
}

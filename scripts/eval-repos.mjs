// Scanner accuracy on real repositories (manual; not run in CI).
//
//   pnpm eval:repos                                         # this checkout's CLI build
//   pnpm eval:repos --cli "npx --yes deployhealth-scan@0.2.0"
//   pnpm eval:repos --only calcom/cal.com --out /tmp/eval   # also write each repo's --json output
//
// Each repository is fetched at a pinned commit (shallow, cached between runs) and scanned with
// `--dry-run --json`. The table has counts only: MISSING / UNUSED / MISMATCH are distinct variable
// names, OPTIONAL is the dry-run's OPTIONAL rows, and the skipped columns are what the CLI reports
// (a vendored directory counts once). "—" means that CLI doesn't report it.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/** Default branches as of 2026-10-01. Bump deliberately: results are only comparable at the same commits. */
const REPOS = [
  { repo: 'vercel/commerce', sha: '3761e52e60df9c6a316e067dbfd7032e494d3634' },
  { repo: 'shadcn-ui/taxonomy', sha: '298a8857c7128a0d121e7f699dfd729f23b3966d' },
  { repo: 't3-oss/create-t3-app', sha: '4709861f7e67a15564c0460c13e7b4b6cfcae40d' },
  { repo: 'fastapi/full-stack-fastapi-template', sha: 'cb740b656d7a0a6c5e12c7bf8e50343ec94ee9c7' },
  { repo: 'calcom/cal.com', sha: '54343aa685ae8f33159d2f485ec4a57bad5c574a' },
  { repo: 'mastodon/mastodon', sha: 'cfbfe77290a918be6846f9ffa2d28d4c4f926b3d' },
  { repo: 'langgenius/dify', sha: '0bd950fd01e9d0b357601fb1a418673465304ede' },
  // PHP / Laravel (Phase 5), default branches as of 2026-10-08.
  { repo: 'laravel/laravel', sha: 'f4000aeb018fcbf71d4a13e3ee4b80c7e2d45be5' },
  { repo: 'BookStackApp/BookStack', sha: 'ff661b59f6f605bf768fe850c0d0a8a2dc09d203' },
  { repo: 'koel/koel', sha: '72ab1e8d9bc4b744b2043a5259e1a06d733a9a29' },
];

const ROOT = resolve(import.meta.dirname, '..');

const { values } = parseArgs({
  options: {
    cli: { type: 'string', default: `node ${join(ROOT, 'packages/core/bin/deployhealth-scan.mjs')}` },
    only: { type: 'string', multiple: true },
    cache: { type: 'string', default: join(ROOT, 'node_modules/.cache/eval-repos') },
    out: { type: 'string' },
  },
});

const [command, ...commandArgs] = values.cli.split(/\s+/).filter(Boolean);
const repos = values.only ? REPOS.filter((r) => values.only.includes(r.repo)) : REPOS;
if (repos.length === 0) throw new Error(`no repository matches --only ${values.only.join(', ')}`);

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** A checkout of `repo` at `sha` in the cache, fetched (depth 1) unless it's already there. */
function checkout({ repo, sha }) {
  const dir = join(values.cache, repo.replace('/', '__'));
  if (existsSync(join(dir, '.git')) && git(['rev-parse', 'HEAD'], dir) === sha) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(['init', '--quiet'], dir);
  git(['fetch', '--quiet', '--depth', '1', `https://github.com/${repo}.git`, sha], dir);
  git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', 'FETCH_HEAD'], dir);
  return dir;
}

function scan(dir) {
  const result = spawnSync(command, [...commandArgs, '--dir', dir, '--dry-run', '--json'], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`${values.cli} exited ${result.status}: ${result.stderr.trim().slice(0, 500)}`);
  return JSON.parse(result.stdout);
}

const count = (list) => (Array.isArray(list) ? list.length : undefined);
const cell = (value) => (value === undefined ? '—' : String(value));

const rows = [];
for (const target of repos) {
  const dir = checkout(target);
  const started = Date.now();
  const json = scan(dir);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (values.out) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(join(values.out, `${target.repo.replace('/', '__')}.json`), JSON.stringify(json, null, 2));
  }
  const vendored = count(json.vendored_skipped);
  const tooLarge = count(json.too_large_skipped);
  rows.push([
    target.repo,
    json.counts.missing,
    json.counts.unused,
    json.counts.mismatch,
    json.variables.filter((v) => v.optional && v.defined_in.length === 0).length,
    cell(json.test_files_skipped),
    vendored === undefined && tooLarge === undefined ? '—' : (vendored ?? 0) + (tooLarge ?? 0),
    `${seconds}s`,
  ]);
  process.stderr.write(`${target.repo}: done in ${seconds}s\n`);
}

const header = ['Repository', 'MISSING', 'UNUSED', 'MISMATCH', 'OPTIONAL', 'Skipped: tests', 'Skipped: vendored', 'Time'];
const lines = [header, header.map((_, i) => (i === 0 ? '---' : '---:')), ...rows].map((r) => `| ${r.join(' | ')} |`);
process.stdout.write(`CLI: ${values.cli}\n\n${lines.join('\n')}\n`);

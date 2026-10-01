import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, run, type CliIo } from '../src/cli';
import { ingestPayloadSchema } from '../src/ingest';

const FIXTURE = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
const DEFAULTS = fileURLToPath(new URL('./fixtures/defaults/', import.meta.url));
const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

function makeIo(overrides: Partial<CliIo> = {}) {
  const out = { stdout: '', stderr: '' };
  const io: CliIo = {
    cwd: FIXTURE,
    stdout: (t) => void (out.stdout += t),
    stderr: (t) => void (out.stderr += t),
    fetch: () => Promise.reject(new Error('fetch not expected')),
    git: () => null,
    now: () => new Date('2026-09-28T12:00:00.000Z'),
    ...overrides,
  };
  return { io, out };
}

describe('--version and --help', () => {
  it('print to stdout and exit 0 without scanning', async () => {
    const { io, out } = makeIo({ cwd: '/nonexistent' });
    expect(await run(['--version'], io)).toBe(EXIT.ok);
    expect(out.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(await run(['-h'], io)).toBe(EXIT.ok);
    expect(out.stdout).toContain('Usage: deployhealth-scan [options]');
    expect(out.stderr).toBe('');
  });
});

describe('--dry-run', () => {
  it('prints grouped findings with file:line and sends nothing', async () => {
    const { io, out } = makeIo();
    expect(await run(['--dry-run'], io)).toBe(EXIT.ok);
    expect(out.stdout).toContain('scopes: (root), apps/admin');
    expect(out.stdout).toContain('MISSING (8)');
    expect(out.stdout).toMatch(/AWS_REGION\s+src\/server\.ts:5/);
    expect(out.stdout).toContain('UNUSED (4)');
    expect(out.stdout).toMatch(/SENTRY_DSN\s+\.env\.example:4 \(missing from \.env\)/);
    expect(out.stdout).toContain('Skipped (the platform or runtime provides them): NODE_ENV. --no-default-ignore includes them.');
  });

  it('checks platform and runtime names too with --no-default-ignore', async () => {
    const { io, out } = makeIo();
    expect(await run(['--dry-run', '--no-default-ignore'], io)).toBe(EXIT.ok);
    expect(out.stdout).toContain('MISSING (9)');
    expect(out.stdout).toMatch(/NODE_ENV\s+src\/server\.ts:6/);
    expect(out.stdout).not.toContain('Skipped');
  });

  it('skips tests and fixtures, says how many, and scans them with --include-tests', async () => {
    // Scanning packages/core itself: its test/ directory (fixtures included) is left out by default.
    const core = fileURLToPath(new URL('..', import.meta.url));
    const { io, out } = makeIo({ cwd: core });
    expect(await run(['--dry-run', '--json'], io)).toBe(EXIT.ok);
    const skipped = JSON.parse(out.stdout);
    expect(skipped.test_files_skipped).toBeGreaterThan(20);
    expect(skipped.scopes).toEqual([]); // no fixture scopes (and core's own code reads no env vars)
    const { io: io2, out: out2 } = makeIo({ cwd: core });
    expect(await run(['--dry-run'], io2)).toBe(EXIT.ok);
    expect(out2.stdout).toMatch(/Skipped \d+ test and fixture files \(read only to see which variables they use\)\. --include-tests includes them\./);

    const { io: io3, out: out3 } = makeIo({ cwd: core });
    expect(await run(['--dry-run', '--json', '--include-tests'], io3)).toBe(EXIT.ok);
    const all = JSON.parse(out3.stdout);
    expect(all.test_files_skipped).toBe(0);
    expect(all.scopes).toEqual(expect.arrayContaining(['test/fixtures/project', 'test/fixtures/defaults/services/api']));
  });

  it('lists optional variables and a scope with no env file instead of MISSING rows', async () => {
    const { io, out } = makeIo({ cwd: DEFAULTS });
    expect(await run(['--dry-run'], io)).toBe(EXIT.ok);
    expect(out.stdout).toContain('MISSING (5)');
    expect(out.stdout).not.toMatch(/DEPLOY_KEY|RELEASE_TOKEN/);
    expect(out.stdout).toContain('OPTIONAL (8): a default in code, not defined in an env file');
    expect(out.stdout).toMatch(/DEPLOY_TARGET\s+\(root\)/);
    expect(out.stdout).toMatch(/SMTP_PORT\s+services\/mailer/);
    expect(out.stdout).toContain('No .env.example in the repository root: 5 variables referenced (--json lists them).');
    expect(out.stdout).toContain('Skipped (the platform or runtime provides them): CI, GITHUB_SHA, NODE_ENV, VERCEL_URL, npm_package_version.');
  });

  it('says which vendored code and which files over 512 KB it skipped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deployhealth-cli-vendored-'));
    const tree: Record<string, string> = {
      '.env.example': 'APP_KEY=\n',
      'src/app.ts': 'process.env.APP_KEY',
      '.yarn/releases/yarn-4.0.0.cjs': 'process.env.FROM_YARN',
      'src/bundle.js': `process.env.FROM_BUNDLE\n${'/'.repeat(600 * 1024)}`,
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`public/chunk${i}.min.js`, 'process.env.FROM_MIN'])),
    };
    for (const [rel, content] of Object.entries(tree)) {
      await mkdir(dirname(join(dir, rel)), { recursive: true });
      await writeFile(join(dir, rel), content);
    }
    try {
      const { io, out } = makeIo({ cwd: dir });
      expect(await run(['--dry-run'], io)).toBe(EXIT.ok);
      expect(out.stdout).toContain('MISSING (0)');
      expect(out.stdout).toContain(
        'Skipped vendored and generated code: .yarn/, public/chunk0.min.js, public/chunk1.min.js, public/chunk2.min.js, public/chunk3.min.js and 2 more (--json lists them).',
      );
      expect(out.stdout).toContain('Skipped 1 file over 512 KB (bundles, not code people wrote): src/bundle.js.');
      const { io: io2, out: out2 } = makeIo({ cwd: dir });
      expect(await run(['--dry-run', '--json'], io2)).toBe(EXIT.ok);
      const json = JSON.parse(out2.stdout);
      expect(json.vendored_skipped).toEqual(['.yarn/', ...Array.from({ length: 6 }, (_, i) => `public/chunk${i}.min.js`)]);
      expect(json.too_large_skipped).toEqual(['src/bundle.js']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prints JSON and honors --ignore, --exclude and --dir', async () => {
    const { io, out } = makeIo({ cwd: fileURLToPath(new URL('.', import.meta.url)) });
    const code = await run(
      ['--dry-run', '--json', '--dir', 'fixtures/project', '--ignore', 'SMTP_*', '--exclude', 'apps/'],
      io,
    );
    expect(code).toBe(EXIT.ok);
    const json = JSON.parse(out.stdout);
    expect(json.scopes).toEqual(['']);
    expect(json.counts).toEqual({ missing: 6, unused: 3, mismatch: 3 });
    expect(json.env_scopes).toEqual([{ scope: '', env_files: ['.env.example', '.env', '.env.local'] }]);
    expect(json.default_ignored).toEqual(['NODE_ENV']);
  });
});

describe('reporting', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const received: Array<{ req: IncomingMessage; body: string }> = [];
  let status = 201;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        received.push({ req, body });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          status < 300
            ? JSON.stringify({ deployId: 'dep-1', scanId: 'scan-1', counts: { missing: 9, unused: 4, mismatch: 3 } })
            : JSON.stringify({ error: 'invalid token' }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('POSTs the scan with the bearer token and a valid payload', async () => {
    status = 201;
    received.length = 0;
    const { io, out } = makeIo({ fetch: globalThis.fetch });
    const code = await run(['--url', `${baseUrl}/`, '--token', 'dh_secret', '--sha', SHA, '--branch', 'main'], io);

    expect(code).toBe(EXIT.ok);
    expect(received).toHaveLength(1);
    const [{ req, body }] = received as [(typeof received)[number]];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/ingest/scan');
    expect(req.headers.authorization).toBe('Bearer dh_secret');
    const payload = ingestPayloadSchema.parse(JSON.parse(body));
    expect(payload).toMatchObject({ sha: SHA, branch: 'main', timestamp: '2026-09-28T12:00:00.000Z' });
    expect(payload.findings).toHaveLength(15);
    expect(payload.variables).toHaveLength(14);
    expect(payload.variables).toContainEqual({ var_name: 'API_KEY', scope: 'apps/admin', defined_in: [] });
    expect(payload.env_scopes).toEqual([
      { scope: '', env_files: ['.env.example', '.env', '.env.local'] },
      { scope: 'apps/admin', env_files: ['.env.example'] },
    ]);
    expect(out.stdout).toContain('reported a1b2c3d on main: 9 missing, 4 unused, 3 mismatch (deploy dep-1)');
  });

  it('sends optional variables and the scopes with no env file', async () => {
    status = 201;
    received.length = 0;
    const { io } = makeIo({ cwd: DEFAULTS, fetch: globalThis.fetch });
    expect(await run(['--url', baseUrl, '--token', 'dh_secret', '--sha', SHA, '--branch', 'main'], io)).toBe(EXIT.ok);
    const payload = ingestPayloadSchema.parse(JSON.parse(received[0]!.body));
    expect(payload.variables).toContainEqual({ var_name: 'DEPLOY_TARGET', scope: '', defined_in: [], optional: true });
    expect(payload.variables).toContainEqual({ var_name: 'DEPLOY_KEY', scope: '', defined_in: [] });
    expect(payload.env_scopes).toContainEqual({ scope: '', env_files: [] });
    expect(payload.findings.some((f) => f.file?.startsWith('scripts/'))).toBe(false);
  });

  it('exits 1 with the server response when ingest is rejected', async () => {
    status = 401;
    const { io, out } = makeIo({ fetch: globalThis.fetch });
    const code = await run(['--url', baseUrl, '--token', 'dh_wrong', '--sha', SHA, '--branch', 'main'], io);
    expect(code).toBe(EXIT.failed);
    expect(out.stderr).toContain('ingest failed with HTTP 401: {"error":"invalid token"}');
  });
});

describe('arguments', () => {
  it('reads sha and branch from git when not given', async () => {
    let body = '';
    const { io } = makeIo({
      git: (args) => (args.includes('--abbrev-ref') ? 'feature/x' : SHA),
      fetch: async (_url, init) => {
        body = String(init?.body);
        return Response.json({ deployId: 'd', scanId: 's', counts: { missing: 0, unused: 0, mismatch: 0 } });
      },
    });
    expect(await run(['--url', 'http://x', '--token', 'dh_t'], io)).toBe(EXIT.ok);
    expect(JSON.parse(body)).toMatchObject({ sha: SHA, branch: 'feature/x' });
  });

  it('refuses a detached HEAD without --branch', async () => {
    const { io, out } = makeIo({ git: (args) => (args.includes('--abbrev-ref') ? 'HEAD' : SHA) });
    expect(await run(['--url', 'http://x', '--token', 'dh_t'], io)).toBe(EXIT.usage);
    expect(out.stderr).toContain('pass --sha and --branch');
  });

  it.each([
    ['no url or token', []],
    ['unknown flag', ['--dry-run', '--nope']],
    ['positional argument', ['--dry-run', 'extra']],
    ['bad sha', ['--url', 'http://x', '--token', 'dh_t', '--sha', 'zzz', '--branch', 'main']],
  ])('exits 2 for %s', async (_label, args) => {
    const { io } = makeIo();
    expect(await run(args, io)).toBe(EXIT.usage);
  });

  it('reports network errors with exit 1', async () => {
    const { io, out } = makeIo({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect(await run(['--url', 'http://x', '--token', 'dh_t', '--sha', SHA, '--branch', 'main'], io)).toBe(EXIT.failed);
    expect(out.stderr).toContain('could not reach http://x/api/ingest/scan: ECONNREFUSED');
  });
});

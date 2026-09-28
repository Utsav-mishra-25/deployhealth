import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, run, type CliIo } from '../src/cli';
import { ingestPayloadSchema } from '../src/ingest';

const FIXTURE = fileURLToPath(new URL('./fixtures/project/', import.meta.url));
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

describe('--dry-run', () => {
  it('prints grouped findings with file:line and sends nothing', async () => {
    const { io, out } = makeIo();
    expect(await run(['--dry-run'], io)).toBe(EXIT.ok);
    expect(out.stdout).toContain('scopes: (root), apps/admin');
    expect(out.stdout).toContain('MISSING (9)');
    expect(out.stdout).toMatch(/AWS_REGION\s+src\/server\.ts:5/);
    expect(out.stdout).toContain('UNUSED (4)');
    expect(out.stdout).toMatch(/SENTRY_DSN\s+\.env\.example:4 \(missing from \.env\)/);
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
    expect(json.counts).toEqual({ missing: 7, unused: 3, mismatch: 3 });
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
    expect(payload.findings).toHaveLength(17);
    expect(out.stdout).toContain('reported a1b2c3d on main: 9 missing, 4 unused, 3 mismatch (deploy dep-1)');
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

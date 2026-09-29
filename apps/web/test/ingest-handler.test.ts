import { hashToken, MAX_INGEST_BODY_BYTES, type FindingRow } from '@deployhealth/core';
import type { RecordScanInput } from '@deployhealth/db';
import { describe, expect, it } from 'vitest';
import { handleIngest, MAX_BODY_BYTES, type IngestDeps } from '@/lib/ingest-handler';

const TOKEN = 'dh_test-token-for-project-1';
const FINDING: FindingRow = { kind: 'missing', var_name: 'API_KEY', file: 'src/a.ts', line: 3, env_file: null };
const PAYLOAD = { sha: 'ABCDEF1234567', branch: 'main', timestamp: '2026-09-28T12:00:00Z', findings: [FINDING] };

function setup() {
  const recorded: RecordScanInput[] = [];
  const deps: IngestDeps = {
    findProjectByTokenHash: async (hash) => (hash === hashToken(TOKEN) ? { id: 'project-1' } : null),
    recordScan: async (input) => {
      recorded.push(input);
      return { deployId: 'deploy-1', scanId: 'scan-1', counts: { missing: 1, unused: 0, mismatch: 0 } };
    },
  };
  return { deps, recorded };
}

function post(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return new Request('http://localhost/api/ingest/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('handleIngest', () => {
  it('stores a valid scan for the token’s project and returns 201', async () => {
    const { deps, recorded } = setup();
    const response = await handleIngest(post(PAYLOAD), deps);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      deployId: 'deploy-1',
      scanId: 'scan-1',
      counts: { missing: 1, unused: 0, mismatch: 0 },
    });
    expect(recorded).toEqual([
      {
        projectId: 'project-1',
        sha: 'abcdef1234567',
        branch: 'main',
        deployedAt: new Date('2026-09-28T12:00:00Z'),
        source: 'ingest',
        findings: [FINDING],
        variables: undefined,
      },
    ]);
  });

  it('passes referenced variables through when the CLI sends them', async () => {
    const { deps, recorded } = setup();
    const variables = [{ var_name: 'DATABASE_URL', scope: 'apps/api', defined_in: ['.env.example'] }];
    const response = await handleIngest(post({ ...PAYLOAD, variables }), deps);
    expect(response.status).toBe(201);
    expect(recorded[0]?.variables).toEqual(variables);
  });

  it('rejects a variable that carries a value', async () => {
    const { deps, recorded } = setup();
    const variables = [{ var_name: 'STRIPE_KEY=sk_live_123', scope: '', defined_in: [] }];
    expect((await handleIngest(post({ ...PAYLOAD, variables }), deps)).status).toBe(400);
    expect(recorded).toEqual([]);
  });

  it.each([
    ['no header', {}],
    ['wrong scheme', { authorization: `Basic ${TOKEN}` }],
    ['non-deployhealth token', { authorization: 'Bearer ghp_abc' }],
    ['unknown token', { authorization: 'Bearer dh_nope' }],
  ])('returns 401 for %s and stores nothing', async (_label, headers) => {
    const { deps, recorded } = setup();
    const response = await handleIngest(post(PAYLOAD, headers), deps);
    expect(response.status).toBe(401);
    expect(recorded).toEqual([]);
  });

  it('returns 400 for invalid JSON', async () => {
    const response = await handleIngest(post('{not json'), setup().deps);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Body is not valid JSON' });
  });

  it('returns 400 with the failing fields for an invalid payload', async () => {
    const { deps, recorded } = setup();
    const response = await handleIngest(post({ ...PAYLOAD, sha: 'nope', findings: [{ kind: 'bogus' }] }), deps);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: Array<{ path: string }> };
    expect(body.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['sha', 'findings.0.kind']));
    expect(recorded).toEqual([]);
  });

  it('returns 413 for oversized bodies', async () => {
    expect(MAX_BODY_BYTES).toBe(MAX_INGEST_BODY_BYTES);
    const huge = JSON.stringify({ ...PAYLOAD, padding: 'x'.repeat(MAX_BODY_BYTES) });
    const response = await handleIngest(post(huge), setup().deps);
    expect(response.status).toBe(413);
  });

  it('stops reading a chunked body without Content-Length as soon as it passes 5 MB', async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk); // endless: only the cap stops it
      },
    });
    const request = new Request('http://localhost/api/ingest/scan', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    const { deps, recorded } = setup();
    const response = await handleIngest(request, deps);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThanOrEqual(8); // 6 MB read, plus what the stream queued ahead
    expect(recorded).toEqual([]);
  });

  it('accepts a body of exactly 5 MB', async () => {
    const base = JSON.stringify(PAYLOAD);
    const padded = `${base}${' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(base))}`;
    expect(Buffer.byteLength(padded)).toBe(MAX_BODY_BYTES);
    expect((await handleIngest(post(padded), setup().deps)).status).toBe(201);
  });
});

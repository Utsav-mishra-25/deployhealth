import { hashToken, type FindingRow } from '@deployhealth/core';
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
      },
    ]);
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
    const huge = JSON.stringify({ ...PAYLOAD, padding: 'x'.repeat(MAX_BODY_BYTES) });
    const response = await handleIngest(post(huge), setup().deps);
    expect(response.status).toBe(413);
  });
});

import { hashToken, ingestPayloadSchema, MAX_INGEST_BODY_BYTES, parseBearer, type IngestResponse } from '@deployhealth/core';
import type { RecordScanInput, RecordScanResult } from '@deployhealth/db';

/** The hard cap from core (5 MB): generous for real repos (10k findings is ~1.5 MB). */
export const MAX_BODY_BYTES = MAX_INGEST_BODY_BYTES;

export interface IngestDeps {
  findProjectByTokenHash: (hash: string) => Promise<{ id: string } | null>;
  recordScan: (input: RecordScanInput) => Promise<RecordScanResult>;
}

/**
 * POST /api/ingest/scan. Authenticates the bearer token before reading the body, validates the
 * payload with the schema shared with the CLI, then stores deploy + scan + findings.
 */
export async function handleIngest(request: Request, deps: IngestDeps): Promise<Response> {
  const token = parseBearer(request.headers.get('authorization'));
  if (!token) return error(401, 'Missing or malformed "Authorization: Bearer dh_…" header');

  const project = await deps.findProjectByTokenHash(hashToken(token));
  if (!project) return error(401, 'Unknown or revoked token');

  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();
  const text = await readBodyUpTo(request, MAX_BODY_BYTES);
  if (text === null) return tooLarge();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return error(400, 'Body is not valid JSON');
  }

  const parsed = ingestPayloadSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message }));
    return Response.json({ error: 'Invalid payload', issues }, { status: 400 });
  }

  const { sha, branch, timestamp, findings, variables } = parsed.data;
  const result = await deps.recordScan({
    projectId: project.id,
    sha: sha.toLowerCase(),
    branch,
    deployedAt: new Date(timestamp),
    source: 'ingest',
    findings,
    variables,
  });
  return Response.json(result satisfies IngestResponse, { status: 201 });
}

/**
 * The body as text, or null once it passes `max` bytes. Counts while streaming, so a chunked
 * upload without Content-Length can't make the server buffer more than the cap.
 */
async function readBodyUpTo(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function tooLarge(): Response {
  return error(413, `Payload larger than ${MAX_BODY_BYTES / 1024 / 1024} MB`);
}

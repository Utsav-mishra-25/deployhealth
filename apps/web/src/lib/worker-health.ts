/** The deep health check's path, rate-limited per IP in middleware.ts. */
export const WORKER_HEALTH_PATH = '/api/health/worker';

const HEADERS = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

/**
 * 200 {"ok":true} when the worker finished a check-endpoints run in the last 3 minutes, else 503
 * {"ok":false}, including when the database can't be read. Nothing else, ever: no counts, names,
 * hosts or timestamps, and nothing logged.
 */
export async function workerHealthResponse(isHealthy: () => Promise<boolean>): Promise<Response> {
  let ok = false;
  try {
    ok = await isHealthy();
  } catch {
    ok = false;
  }
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: HEADERS });
}

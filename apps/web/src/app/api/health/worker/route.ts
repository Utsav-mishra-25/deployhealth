import { workerIsHealthy } from '@deployhealth/db';
import { getDb } from '@/lib/db';
import { workerHealthResponse } from '@/lib/worker-health';

// The deep check for external monitors: is the worker alive? (/api/health stays Railway's
// database-free deploy healthcheck.) Reads one row; rate-limited per IP in middleware.ts.
export const dynamic = 'force-dynamic';

export function GET(): Promise<Response> {
  return workerHealthResponse(() => workerIsHealthy(getDb()));
}

export async function HEAD(): Promise<Response> {
  const response = await GET();
  return new Response(null, { status: response.status, headers: response.headers });
}

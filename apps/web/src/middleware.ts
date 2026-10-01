import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, createRateLimiter } from '@/lib/rate-limit';
import { WORKER_HEALTH_PATH } from '@/lib/worker-health';

/** Public shared reports: 30 requests per minute per IP. */
export const SHARED_REPORT_LIMIT = { limit: 30, windowMs: 60_000 };
/** The deep health check: the same, counted separately, so monitors and share links never share a window. */
export const WORKER_HEALTH_LIMIT = { limit: 30, windowMs: 60_000 };

const sharedReports = createRateLimiter(SHARED_REPORT_LIMIT);
const workerHealth = createRateLimiter(WORKER_HEALTH_LIMIT);

export function middleware(request: NextRequest): NextResponse {
  const limiter = request.nextUrl.pathname === WORKER_HEALTH_PATH ? workerHealth : sharedReports;
  const result = limiter.check(clientIp(request.headers));
  if (result.ok) return NextResponse.next();
  return new NextResponse('Too many requests. Try again in a minute.', {
    status: 429,
    headers: { 'retry-after': String(result.retryAfterSeconds), 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });
}

// Node.js runtime, so the limiter's memory lives in the server process.
// The matcher must be literals (Next reads it at build time); the test pins it to WORKER_HEALTH_PATH.
export const config = { matcher: ['/share/:path*', '/api/health/worker'], runtime: 'nodejs' };

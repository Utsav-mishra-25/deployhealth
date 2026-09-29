import { NextResponse, type NextRequest } from 'next/server';
import { clientIp, createRateLimiter } from '@/lib/rate-limit';

/** Public shared reports: 30 requests per minute per IP. */
export const SHARED_REPORT_LIMIT = { limit: 30, windowMs: 60_000 };

const limiter = createRateLimiter(SHARED_REPORT_LIMIT);

export function middleware(request: NextRequest): NextResponse {
  const result = limiter.check(clientIp(request.headers));
  if (result.ok) return NextResponse.next();
  return new NextResponse('Too many requests. Try again in a minute.', {
    status: 429,
    headers: { 'retry-after': String(result.retryAfterSeconds), 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' },
  });
}

// Node.js runtime, so the limiter's memory lives in the server process.
export const config = { matcher: ['/share/:path*'], runtime: 'nodejs' };

import { clientIp } from '@/lib/rate-limit';

// Railway's deploy healthcheck. Deliberately does not touch the database.
export const dynamic = 'force-dynamic';

/**
 * `?ip=1` also logs the client IP the /share rate limiter would key on, next to the raw
 * X-Forwarded-For header, so a deploy can prove the proxy's hop wins over a spoofed one
 * (docs/deploy-railway.md, "Verify the rate limiter"). Opt-in, so monitors don't flood the log.
 */
export function GET(request: Request): Response {
  if (new URL(request.url).searchParams.get('ip') === '1') {
    const forwarded = (request.headers.get('x-forwarded-for') ?? '').slice(0, 200);
    console.log(`[health] client ip ${clientIp(request.headers)} (x-forwarded-for: ${forwarded || 'none'})`);
  }
  return Response.json({ ok: true });
}

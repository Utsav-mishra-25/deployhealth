import { baseUrlFrom } from '@/lib/app-url';
import { securityContact, securityTxt } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * Its URLs come from the request's host headers, so it's never cached (`no-store`): a shared
 * cache can't keep a copy built from someone else's forged X-Forwarded-Host.
 */
export function GET(request: Request): Response {
  const body = securityTxt({ baseUrl: baseUrlFrom(request.headers), contact: securityContact(), now: new Date() });
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

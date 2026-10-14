import { publicOriginFor } from '@/lib/app-url';
import { securityContact, securityTxt } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * Its URLs come from PUBLIC_ORIGIN (lib/app-url.ts). It's never cached (`no-store`): without
 * PUBLIC_ORIGIN they follow the request's host headers, and a shared cache must never keep a copy
 * built from someone else's forged X-Forwarded-Host.
 */
export function GET(request: Request): Response {
  const body = securityTxt({ baseUrl: publicOriginFor(request.headers), contact: securityContact(), now: new Date() });
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

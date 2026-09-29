import { baseUrlFrom } from '@/lib/app-url';
import { securityContact, securityTxt } from '@/lib/security';

export const dynamic = 'force-dynamic';

export function GET(request: Request): Response {
  const body = securityTxt({ baseUrl: baseUrlFrom(request.headers), contact: securityContact(), now: new Date() });
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}

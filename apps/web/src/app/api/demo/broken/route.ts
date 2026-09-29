import { isDemoPublic } from '@/lib/demo';

export const dynamic = 'force-dynamic';

/**
 * The demo's failing endpoint ("Acme API"): always 503 with no body, so the demo alert is a real
 * one that stays open. 404 unless DEMO_PUBLIC=1.
 */
function broken(): Response {
  if (!isDemoPublic()) return new Response(null, { status: 404 });
  return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
}

export const GET = broken;
export const HEAD = broken;

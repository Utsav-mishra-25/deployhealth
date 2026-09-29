import { headers } from 'next/headers';

/** The public base URL of this deployment, as seen by the browser (behind Railway's proxy too). */
export async function appUrl(): Promise<string> {
  return baseUrlFrom(await headers());
}

/** `appUrl()` for route handlers, from the request's own headers. */
export function baseUrlFrom(h: Headers): string {
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

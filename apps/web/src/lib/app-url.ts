import { headers } from 'next/headers';
import { serverEnv, type ServerEnv } from '@/env';

/**
 * The public origin of this deployment (`https://deployhealth.dev`), for every absolute URL the
 * app builds: security.txt, the sitemap, `metadataBase` (so canonical and Open Graph URLs), the
 * Action snippet (settings page, a new project, the handoff) and share links.
 *
 * It's `PUBLIC_ORIGIN` when set, so a forged Host or X-Forwarded-Host never ends up in them.
 * Unset, it falls back to the request's own headers (fine in development; in production one error
 * is logged, at startup or first use, naming the variable). Reading the headers either way keeps
 * every page that uses it rendered on request, as before: nothing is prerendered with build-time env.
 */
export async function publicOrigin(): Promise<string> {
  return publicOriginFor(await headers());
}

/** `publicOrigin()` for route handlers, from the request's own headers. */
export function publicOriginFor(h: Headers, env: Pick<ServerEnv, 'PUBLIC_ORIGIN' | 'NODE_ENV'> = serverEnv()): string {
  if (env.PUBLIC_ORIGIN) return env.PUBLIC_ORIGIN;
  reportMissingPublicOrigin(env);
  return requestOrigin(h);
}

/** The origin the request claims (Host / X-Forwarded-*). Only a fallback: a client can forge it. */
export function requestOrigin(h: Headers): string {
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

export const MISSING_PUBLIC_ORIGIN_ERROR =
  'PUBLIC_ORIGIN is not set: absolute URLs (security.txt, the sitemap, canonical URLs, the Action snippet, share links) ' +
  "fall back to the request's Host / X-Forwarded-Host headers, which a client can forge. Set PUBLIC_ORIGIN to this " +
  "deployment's public origin, e.g. https://deployhealth.dev (see apps/web/.env.example).";

// On globalThis, not in module scope: instrumentation and each route bundle get their own copy of
// this module, and the error should still be logged once per process.
const REPORTED = Symbol.for('deployhealth.missingPublicOriginReported');
type Flagged = typeof globalThis & { [REPORTED]?: boolean };

/** Logs MISSING_PUBLIC_ORIGIN_ERROR once per process, in production only. */
export function reportMissingPublicOrigin(env: Pick<ServerEnv, 'PUBLIC_ORIGIN' | 'NODE_ENV'> = serverEnv()): void {
  if (env.PUBLIC_ORIGIN || env.NODE_ENV !== 'production') return;
  const flagged = globalThis as Flagged;
  if (flagged[REPORTED]) return;
  flagged[REPORTED] = true;
  console.error(MISSING_PUBLIC_ORIGIN_ERROR);
}

/** Tests only: allow the error to be logged again. */
export function resetPublicOriginReportForTests(): void {
  delete (globalThis as Flagged)[REPORTED];
}

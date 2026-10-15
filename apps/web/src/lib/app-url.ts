import { headers } from 'next/headers';
import { serverEnv, type ServerEnv } from '@/env';

/**
 * The public origin of this deployment (`https://deployhealth.dev`), for every absolute URL the
 * app builds: security.txt, the sitemap, `metadataBase` (so canonical and Open Graph URLs), the
 * Action snippet (settings page, a new project, the handoff) and share links.
 *
 * It's `PUBLIC_ORIGIN` when that is a valid origin, so a forged Host or X-Forwarded-Host never ends
 * up in them. Missing or invalid, it falls back to the request's own headers, as before (fine in
 * development); one error is logged at startup or first use, naming the variable and what's wrong:
 * always for an invalid value, in production for a missing one. Pages never fail over it. Reading
 * the headers either way keeps every page that uses it rendered on request, as before: nothing is
 * prerendered with build-time env.
 */
export async function publicOrigin(): Promise<string> {
  return publicOriginFor(await headers());
}

type OriginEnv = Pick<ServerEnv, 'PUBLIC_ORIGIN' | 'NODE_ENV'>;

/** `publicOrigin()` for route handlers, from the request's own headers. */
export function publicOriginFor(h: Headers, env: OriginEnv = serverEnv()): string {
  const { origin } = parsePublicOrigin(env.PUBLIC_ORIGIN);
  if (origin) return origin;
  reportPublicOriginProblem(env);
  return requestOrigin(h);
}

/** The origin the request claims (Host / X-Forwarded-*). Only a fallback: a client can forge it. */
export function requestOrigin(h: Headers): string {
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto}://${host}`;
}

/**
 * PUBLIC_ORIGIN as an origin (scheme, host, optional port; one trailing slash is dropped), or what's
 * wrong with it. `problem` is null when it's simply not set. The value itself is never echoed.
 */
export function parsePublicOrigin(raw: string | undefined): { origin: string; problem: null } | { origin: null; problem: string | null } {
  if (raw === undefined || raw.trim() === '') return { origin: null, problem: null };
  const value = raw.trim().replace(/\/$/, '');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { origin: null, problem: "it isn't a URL" };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { origin: null, problem: "its scheme isn't http or https" };
  if (url.username || url.password) return { origin: null, problem: 'it has credentials' };
  if (url.search || url.hash || /[?#]/.test(value)) return { origin: null, problem: 'it has a query or fragment' };
  if (value.toLowerCase() !== url.origin.toLowerCase()) return { origin: null, problem: 'it has a path (or more than one trailing slash)' };
  return { origin: url.origin, problem: null };
}

const FALLBACK =
  "absolute URLs (security.txt, the sitemap, canonical URLs, the Action snippet, share links) fall back to the request's " +
  "Host / X-Forwarded-Host headers, which a client can forge. Set PUBLIC_ORIGIN to this deployment's public origin, " +
  'e.g. https://deployhealth.dev (see apps/web/.env.example).';

export const MISSING_PUBLIC_ORIGIN_ERROR = `PUBLIC_ORIGIN is not set: ${FALLBACK}`;
export const invalidPublicOriginError = (problem: string) =>
  `PUBLIC_ORIGIN is invalid (${problem}; expected only a scheme, host and optional port): ${FALLBACK}`;

// On globalThis, not in module scope: instrumentation and each route bundle get their own copy of
// this module, and the error should still be logged once per process.
const REPORTED = Symbol.for('deployhealth.publicOriginProblemReported');
type Flagged = typeof globalThis & { [REPORTED]?: boolean };

/** Logs once per process why PUBLIC_ORIGIN isn't used: invalid (any mode), or missing (production). */
export function reportPublicOriginProblem(env: OriginEnv = serverEnv()): void {
  const { origin, problem } = parsePublicOrigin(env.PUBLIC_ORIGIN);
  if (origin) return;
  if (problem === null && env.NODE_ENV !== 'production') return;
  const flagged = globalThis as Flagged;
  if (flagged[REPORTED]) return;
  flagged[REPORTED] = true;
  console.error(problem === null ? MISSING_PUBLIC_ORIGIN_ERROR : invalidPublicOriginError(problem));
}

/** Tests only: allow the error to be logged again. */
export function resetPublicOriginReportForTests(): void {
  delete (globalThis as Flagged)[REPORTED];
}

import { BlockedUrlError, type EndpointMethod } from '@deployhealth/core';
import { guardedRequest, type HttpRequester, type ResponseHead } from './guarded-http';

export { USER_AGENT, type HttpRequester, type ResponseHead } from './guarded-http';

export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export interface CheckTarget {
  url: string;
  method: EndpointMethod;
  expectedStatus: number;
}

export interface CheckResult {
  checkedAt: Date;
  statusCode: number | null;
  /** Time to the final response's headers, including redirects; null if no response. */
  latencyMs: number | null;
  ok: boolean;
  /** Short, human-readable reason when not ok. */
  error: string | null;
}

export interface CheckDeps {
  request?: HttpRequester;
  now?: () => Date;
  /** Monotonic milliseconds, for latency. */
  clock?: () => number;
  timeoutMs?: number;
  maxRedirects?: number;
}

/**
 * Run one uptime check: follow up to 5 redirects within a 10s budget; ok when the final status
 * equals the expected status. Every failure mode (DNS, timeout, TLS, refused, blocked by the
 * SSRF guard, wrong status) becomes ok=false with a short error, never an exception.
 */
export async function runCheck(target: CheckTarget, deps: CheckDeps = {}): Promise<CheckResult> {
  const request = deps.request ?? guardedRequest;
  const clock = deps.clock ?? (() => performance.now());
  const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const checkedAt = (deps.now ?? (() => new Date()))();
  const started = clock();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const failure = (error: string, statusCode: number | null = null): CheckResult => ({
    checkedAt,
    statusCode,
    latencyMs: null,
    ok: false,
    error,
  });

  try {
    let url = new URL(target.url);
    let method = target.method;
    for (let redirects = 0; ; redirects++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return failure(`Redirected to an unsupported URL (${url.protocol})`);
      }
      const head = await request(url, method, controller.signal);
      if (REDIRECT_STATUSES.has(head.status) && head.location) {
        if (redirects >= maxRedirects) return failure(`Too many redirects (more than ${maxRedirects})`, head.status);
        url = new URL(head.location, url);
        if (head.status === 303) method = 'GET';
        continue;
      }
      const ok = head.status === target.expectedStatus;
      return {
        checkedAt,
        statusCode: head.status,
        latencyMs: Math.max(0, Math.round(clock() - started)),
        ok,
        error: ok ? null : `Expected ${target.expectedStatus}, got ${head.status}`,
      };
    }
  } catch (error) {
    return failure(describeError(error, controller.signal.aborted, timeoutMs));
  } finally {
    clearTimeout(timer);
  }
}

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME', 'EAI_FAIL']);
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'HOSTNAME_MISMATCH',
]);

/** Turn any request failure into a short, stable error string. */
export function describeError(error: unknown, timedOut: boolean, timeoutMs = CHECK_TIMEOUT_MS): string {
  const err = error as { name?: string; code?: string; message?: string };
  if (timedOut || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') return `Timed out after ${timeoutMs / 1000}s`;
  if (error instanceof BlockedUrlError) return `Blocked: ${error.message}`;
  const code = err?.code ?? '';
  if (DNS_CODES.has(code)) return `DNS lookup failed (${code})`;
  if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || code.startsWith('CERT_')) {
    return `TLS error (${code})`;
  }
  if (code === 'ECONNREFUSED') return 'Connection refused';
  if (code === 'ECONNRESET') return 'Connection reset';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Host unreachable';
  if (code === 'ERR_INVALID_URL') return 'Invalid URL';
  return `Request failed: ${err?.message ?? String(error)}`.slice(0, 200);
}

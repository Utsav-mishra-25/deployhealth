import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { ServerEnv } from '@/env';

/** HKDF `info` for the share-link key, so it can never equal a key derived for another purpose. */
export const REPORT_SHARE_HKDF_INFO = 'deployhealth-report-share';

/**
 * The key report share links are signed with: REPORT_SHARE_SECRET when set, otherwise 32 bytes
 * derived from AUTH_SECRET with HKDF-SHA256 (empty salt). With the fallback, rotating AUTH_SECRET
 * also invalidates every share link.
 */
export function reportShareKey(env: Pick<ServerEnv, 'AUTH_SECRET' | 'REPORT_SHARE_SECRET'>): Buffer {
  if (env.REPORT_SHARE_SECRET) return Buffer.from(env.REPORT_SHARE_SECRET, 'utf8');
  return Buffer.from(hkdfSync('sha256', env.AUTH_SECRET, Buffer.alloc(0), REPORT_SHARE_HKDF_INFO, 32));
}

/** Share links last 90 days. They're stateless: rotating the key is the only way to revoke them. */
export const SHARE_LINK_DAYS = 90;

export interface ReportShare {
  clientId: string;
  /** "YYYY-MM" */
  month: string;
  expiresAt: Date;
}

export type ShareVerification = { ok: true; share: ReportShare } | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

const VERSION = 'v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const hmac = (payload: string, key: Buffer) => createHmac('sha256', key).update(payload, 'utf8').digest('base64url');

export function shareLinkExpiry(now: Date): Date {
  return new Date(now.getTime() + SHARE_LINK_DAYS * 86_400_000);
}

/**
 * A share token: base64url("v1.<clientId>.<YYYY-MM>.<expiry, unix seconds>"), a dot, then the
 * base64url HMAC-SHA256 of that payload. Nothing is stored server-side.
 */
export function signReportShare(share: ReportShare, key: Buffer): string {
  const payload = [VERSION, share.clientId, share.month, Math.floor(share.expiresAt.getTime() / 1000)].join('.');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${hmac(payload, key)}`;
}

/** Check the signature first (constant time), then the fields, then the expiry. */
export function verifyReportShare(token: string, key: Buffer, now: Date): ShareVerification {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [encoded, signature] = parts as [string, string];
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  // Only the canonical encoding is accepted, so one payload has exactly one valid token.
  if (Buffer.from(payload, 'utf8').toString('base64url') !== encoded) return { ok: false, reason: 'malformed' };

  const expected = Buffer.from(hmac(payload, key));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad-signature' };

  const [version, clientId, month, expiry, ...rest] = payload.split('.');
  if (version !== VERSION || rest.length || !clientId || !UUID.test(clientId) || !month || !MONTH.test(month) || !/^\d{1,12}$/.test(expiry ?? '')) {
    return { ok: false, reason: 'malformed' };
  }
  const expiresAt = new Date(Number(expiry) * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, share: { clientId, month, expiresAt } };
}

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REPORT_SHARE_HKDF_INFO, reportShareKey, shareLinkExpiry, shareTokenFromParam, signReportShare, verifyReportShare } from '@/lib/share-link';
import { resetServerEnvForTests } from '@/env';

const AUTH_SECRET = 'a'.repeat(32) + '-auth-secret';

/** RFC 5869 HKDF-SHA256 with an empty salt and one output block, written out by hand. */
function hkdfByHand(ikm: string, info: string): Buffer {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest();
}

describe('reportShareKey', () => {
  it('derives the key from AUTH_SECRET with HKDF-SHA256 and the share-link info when unset', () => {
    const key = reportShareKey({ AUTH_SECRET, REPORT_SHARE_SECRET: undefined });
    expect(REPORT_SHARE_HKDF_INFO).toBe('deployhealth-report-share');
    expect(key.equals(hkdfByHand(AUTH_SECRET, 'deployhealth-report-share'))).toBe(true);
    expect(key.equals(Buffer.from(AUTH_SECRET))).toBe(false);
  });

  it('changes when AUTH_SECRET is rotated', () => {
    const before = reportShareKey({ AUTH_SECRET, REPORT_SHARE_SECRET: undefined });
    const after = reportShareKey({ AUTH_SECRET: `${AUTH_SECRET}-rotated`, REPORT_SHARE_SECRET: undefined });
    expect(before.equals(after)).toBe(false);
  });

  it('uses REPORT_SHARE_SECRET as-is when set, independent of AUTH_SECRET', () => {
    const REPORT_SHARE_SECRET = 'r'.repeat(40);
    const key = reportShareKey({ AUTH_SECRET, REPORT_SHARE_SECRET });
    expect(key.toString('utf8')).toBe(REPORT_SHARE_SECRET);
    expect(reportShareKey({ AUTH_SECRET: 'something-else-entirely-32-chars!!', REPORT_SHARE_SECRET }).equals(key)).toBe(true);
  });
});

describe('report share links', () => {
  const key = reportShareKey({ AUTH_SECRET, REPORT_SHARE_SECRET: undefined });
  const NOW = new Date('2026-10-01T09:00:00Z');
  const CLIENT_A = '0d3e0000-0000-4000-8000-00000000000a';
  const CLIENT_B = '0d3e0000-0000-4000-8000-00000000000b';
  const share = { clientId: CLIENT_A, month: '2026-09', expiresAt: shareLinkExpiry(NOW) };
  const token = signReportShare(share, key);
  const reSign = (payload: string) => `${Buffer.from(payload).toString('base64url')}.${token.split('.')[1]}`;

  it('round-trips, and expires 90 days after it was created', () => {
    expect(share.expiresAt).toEqual(new Date('2026-12-30T09:00:00Z'));
    expect(verifyReportShare(token, key, NOW)).toEqual({ ok: true, share });
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a token whose client, month or expiry was edited', () => {
    const payload = Buffer.from(token.split('.')[0]!, 'base64url').toString();
    expect(verifyReportShare(reSign(payload.replace(CLIENT_A, CLIENT_B)), key, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyReportShare(reSign(payload.replace('2026-09', '2026-08')), key, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    const longer = payload.replace(/\.(\d+)$/, (_m, exp: string) => `.${Number(exp) + 86_400 * 365}`);
    expect(verifyReportShare(reSign(longer), key, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a tampered signature or one made with another key', () => {
    const [encoded, signature] = token.split('.') as [string, string];
    const flipped = `${encoded}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;
    expect(verifyReportShare(flipped, key, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyReportShare(`${encoded}.${signature.slice(0, -2)}`, key, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    const otherKey = reportShareKey({ AUTH_SECRET: `${AUTH_SECRET}-other`, REPORT_SHARE_SECRET: undefined });
    expect(verifyReportShare(token, otherKey, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifyReportShare(signReportShare(share, otherKey), key, NOW)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('enforces the expiry', () => {
    expect(verifyReportShare(token, key, new Date(share.expiresAt.getTime() - 1000)).ok).toBe(true);
    expect(verifyReportShare(token, key, share.expiresAt)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyReportShare(token, key, new Date('2027-06-01T00:00:00Z'))).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects malformed tokens, even correctly signed ones', () => {
    for (const bad of ['', 'abc', 'a.b.c', `${token}.x`, '.sig', 'payload.']) expect(verifyReportShare(bad, key, NOW)).toEqual({ ok: false, reason: 'malformed' });
    for (const payload of [`v2.${CLIENT_A}.2026-09.1893456000`, 'v1.not-a-uuid.2026-09.1893456000', `v1.${CLIENT_A}.2026-13.1893456000`, `v1.${CLIENT_A}.2026-09.soon`]) {
      const signed = `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
      expect(verifyReportShare(signed, key, NOW), payload).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

describe('malformed share tokens', () => {
  it('decodes a route param, or gives null for a malformed escape', () => {
    expect(shareTokenFromParam('abc.def')).toBe('abc.def');
    expect(shareTokenFromParam('a%2Eb')).toBe('a.b');
    expect(shareTokenFromParam('%E0%A4%A')).toBeNull();
    expect(shareTokenFromParam('%')).toBeNull();
  });

  it('404s on the shared report page, never a 500', async () => {
    Object.assign(process.env, { DATABASE_URL: 'postgres://x@localhost/db', AUTH_SECRET: 'x'.repeat(32) });
    resetServerEnvForTests();
    const { default: SharedReportPage } = await import('@/app/share/reports/[token]/page');
    for (const token of ['%E0%A4%A', '%', 'not-a-token', `${'a'.repeat(5_000)}.${'b'.repeat(43)}`, '..', 'YQ.YQ']) {
      const error = await SharedReportPage({ params: Promise.resolve({ token }) }).catch((e: unknown) => e);
      expect((error as { digest?: string }).digest).toMatch(/;404$/);
    }
  });
});

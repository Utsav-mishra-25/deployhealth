import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { REPORT_SHARE_HKDF_INFO, reportShareKey } from '@/lib/share-link';

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

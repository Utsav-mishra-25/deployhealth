import { hkdfSync } from 'node:crypto';
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

'use server';

import { parseMonth } from '@deployhealth/core';
import { getClientForOwner } from '@deployhealth/db';
import { serverEnv } from '@/env';
import { appUrl } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';
import { requireWritableUser } from '@/lib/guard';
import { reportShareKey, shareLinkExpiry, signReportShare } from '@/lib/share-link';

export type ShareLinkState = { status: 'idle' } | { status: 'created'; url: string; expiresAt: string } | { status: 'error'; message: string };

/**
 * A signed, stateless link to one client's report for one month, valid for 90 days. Anyone with
 * the link can read that report (and nothing else); rotating REPORT_SHARE_SECRET revokes them all.
 */
export async function createReportShareLinkAction(clientId: string, month: string): Promise<ShareLinkState> {
  const user = await requireWritableUser();
  if (!isUuid(clientId) || !parseMonth(month)) return { status: 'error', message: 'Report not found.' };
  const client = await getClientForOwner(getDb(), user.id, clientId);
  if (!client) return { status: 'error', message: 'Report not found.' };

  const expiresAt = shareLinkExpiry(new Date());
  const token = signReportShare({ clientId: client.id, month, expiresAt }, reportShareKey(serverEnv()));
  return { status: 'created', url: `${await appUrl()}/share/reports/${token}`, expiresAt: expiresAt.toISOString() };
}

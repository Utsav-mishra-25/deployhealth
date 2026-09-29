import { formatUtc, parseMonth } from '@deployhealth/core';
import { getClientReport } from '@deployhealth/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PrintButton } from '@/components/print-button';
import { serverEnv } from '@/env';
import { getDb } from '@/lib/db';
import { reportShareKey, verifyReportShare } from '@/lib/share-link';
import { ReportView } from '@/views/report-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Monthly report · deployhealth', robots: { index: false, follow: false } };

/**
 * A report opened from a signed share link: no session. The token names exactly one client and
 * one month; getClientReport reads nothing else. Rate-limited per IP in middleware.ts.
 */
export default async function SharedReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const now = new Date();
  const verified = verifyReportShare(decodeURIComponent(token), reportShareKey(serverEnv()), now);

  if (!verified.ok && verified.reason === 'expired') {
    return (
      <div className="mx-auto mt-16 max-w-md rounded-lg border border-gray-200 bg-white p-8 text-center" role="alert">
        <h1 className="text-lg font-semibold">This report link has expired</h1>
        <p className="mt-2 text-sm text-gray-600">Share links last 90 days. Ask for a new one.</p>
      </div>
    );
  }
  if (!verified.ok) notFound();

  const month = parseMonth(verified.share.month);
  const data = month ? await getClientReport(getDb(), verified.share.clientId, month, now) : null;
  if (!data) notFound();

  return (
    <ReportView
      data={data}
      toolbar={
        <>
          <p className="text-sm text-gray-600">Shared report · this link works until {formatUtc(verified.share.expiresAt)}</p>
          <PrintButton />
        </>
      }
    />
  );
}

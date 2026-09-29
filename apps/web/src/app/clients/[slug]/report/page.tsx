import { monthOf, parseMonth } from '@deployhealth/core';
import { getClientBySlug, getClientReport } from '@deployhealth/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { ReportToolbar } from '@/components/report-toolbar';
import { ShareReportButton } from '@/components/share-report-button';
import { getDb } from '@/lib/db';
import { APP_PATHS } from '@/lib/paths';
import { ReportView } from '@/views/report-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Monthly report · deployhealth' };

export default async function ClientReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser();
  const [{ slug }, { month: monthKey }] = await Promise.all([params, searchParams]);
  const now = new Date();
  const month = monthKey === undefined ? monthOf(now) : parseMonth(monthKey);
  if (!month) notFound();

  const db = getDb();
  // Owner check first: getClientReport itself is reachable by share links and isn't owner-scoped.
  const client = await getClientBySlug(db, user.id, slug);
  if (!client) notFound();
  const data = await getClientReport(db, client.id, month, now);
  if (!data) notFound();

  return (
    <ReportView
      data={data}
      toolbar={
        <ReportToolbar
          backHref={APP_PATHS.client(slug)}
          backLabel={client.name}
          month={month}
          monthHref={(key) => APP_PATHS.clientReport(slug, key)}
          now={now}
          share={<ShareReportButton clientId={client.id} month={month.key} />}
        />
      }
    />
  );
}

import { monthOf, parseMonth } from '@deployhealth/core';
import { getClientBySlug, getClientReport } from '@deployhealth/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ReportToolbar } from '@/components/report-toolbar';
import { getDb } from '@/lib/db';
import { demoOwner } from '@/lib/demo';
import { DEMO_PATHS } from '@/lib/paths';
import { ReportView } from '@/views/report-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Monthly report · Live demo · deployhealth' };

export default async function DemoClientReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const demo = await demoOwner();
  const [{ slug }, { month: monthKey }] = await Promise.all([params, searchParams]);
  const now = new Date();
  const month = monthKey === undefined ? monthOf(now) : parseMonth(monthKey);
  if (!month) notFound();

  const db = getDb();
  const client = await getClientBySlug(db, demo.id, slug);
  if (!client) notFound();
  const data = await getClientReport(db, client.id, month, now);
  if (!data) notFound();

  return (
    <ReportView
      data={data}
      toolbar={
        <ReportToolbar
          backHref={DEMO_PATHS.client(slug)}
          backLabel={client.name}
          month={month}
          monthHref={(key) => DEMO_PATHS.clientReport(slug, key)}
          now={now}
        />
      }
    />
  );
}

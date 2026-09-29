import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { loadHandoff } from '@/lib/handoff';
import { APP_PATHS } from '@/lib/paths';
import { HandoffView } from '@/views/handoff-view';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Handoff · deployhealth' };

export default async function HandoffPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireUser();
  const { projectId } = await params;
  const data = await loadHandoff(user.id, projectId);
  if (!data) notFound();
  return <HandoffView data={data} backHref={APP_PATHS.project(projectId)} markdownHref={APP_PATHS.handoffMarkdown(projectId)} />;
}

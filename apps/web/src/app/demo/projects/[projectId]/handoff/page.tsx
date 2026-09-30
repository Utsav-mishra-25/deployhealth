import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { demoOwner } from '@/lib/demo';
import { loadHandoff } from '@/lib/handoff';
import { DEMO_PATHS } from '@/lib/paths';
import { projectMetadata } from '@/lib/titles';
import { HandoffView } from '@/views/handoff-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  return projectMetadata('demo', (await demoOwner()).id, projectId, 'Handoff');
}

export default async function DemoHandoffPage({ params }: { params: Promise<{ projectId: string }> }) {
  const demo = await demoOwner();
  const { projectId } = await params;
  const data = await loadHandoff(demo.id, projectId);
  if (!data) notFound();
  return <HandoffView data={data} backHref={DEMO_PATHS.project(projectId)} markdownHref={DEMO_PATHS.handoffMarkdown(projectId)} />;
}

import type { Metadata } from 'next';
import { demoOwner } from '@/lib/demo';
import { DEMO_PATHS } from '@/lib/paths';
import { projectMetadata } from '@/lib/titles';
import { ProjectView } from '@/views/project-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  return projectMetadata('demo', (await demoOwner()).id, projectId);
}

export default async function DemoProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ deploy?: string }>;
}) {
  const demo = await demoOwner();
  const { projectId } = await params;
  const { deploy } = await searchParams;
  return <ProjectView ownerId={demo.id} projectId={projectId} requestedDeploy={deploy} paths={DEMO_PATHS} readOnly />;
}

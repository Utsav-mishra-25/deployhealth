import { demoOwner } from '@/lib/demo';
import { DEMO_PATHS } from '@/lib/paths';
import { ProjectView } from '@/views/project-view';

export const dynamic = 'force-dynamic';

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

import { requireUser } from '@/auth';
import { APP_PATHS } from '@/lib/paths';
import { ProjectView } from '@/views/project-view';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ deploy?: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;
  const { deploy } = await searchParams;
  return <ProjectView ownerId={user.id} projectId={projectId} requestedDeploy={deploy} paths={APP_PATHS} readOnly={false} />;
}

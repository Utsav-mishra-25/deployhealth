import type { Metadata } from 'next';
import { auth, requireUser } from '@/auth';
import { APP_PATHS } from '@/lib/paths';
import { projectMetadata } from '@/lib/titles';
import { ProjectView } from '@/views/project-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ projectId: string }> }): Promise<Metadata> {
  const { projectId } = await params;
  return projectMetadata('app', (await auth())?.user?.id ?? null, projectId);
}

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

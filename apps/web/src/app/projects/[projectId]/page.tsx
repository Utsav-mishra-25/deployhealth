import type { Metadata } from 'next';
import { auth, requireUser } from '@/auth';
import { serverEnv } from '@/env';
import { CREATED_PARAM } from '@/lib/onboarding';
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
  searchParams: Promise<{ deploy?: string; [CREATED_PARAM]?: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;
  const query = await searchParams;
  return (
    <ProjectView
      ownerId={user.id}
      projectId={projectId}
      requestedDeploy={query.deploy}
      paths={APP_PATHS}
      readOnly={false}
      created={query[CREATED_PARAM] === '1'}
      appSlug={serverEnv().GITHUB_APP_SLUG}
    />
  );
}

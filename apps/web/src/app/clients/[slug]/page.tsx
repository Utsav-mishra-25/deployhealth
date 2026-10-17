import { listInstallationsForUser } from '@deployhealth/db';
import type { Metadata } from 'next';
import { auth, requireUser } from '@/auth';
import { serverEnv } from '@/env';
import { getDb } from '@/lib/db';
import { appCoversFor } from '@/lib/onboarding';
import { APP_PATHS } from '@/lib/paths';
import { clientMetadata } from '@/lib/titles';
import { ClientView } from '@/views/client-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return clientMetadata('app', (await auth())?.user?.id ?? null, slug);
}

export default async function ClientPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  // The same "Not set up" reasons as /clients.
  const appCovers = appCoversFor(await listInstallationsForUser(getDb(), user.id), serverEnv().GITHUB_APP_SLUG);
  return <ClientView ownerId={user.id} slug={slug} paths={APP_PATHS} readOnly={false} appCovers={appCovers} />;
}

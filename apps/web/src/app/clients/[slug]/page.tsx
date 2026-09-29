import { requireUser } from '@/auth';
import { APP_PATHS } from '@/lib/paths';
import { ClientView } from '@/views/client-view';

export const dynamic = 'force-dynamic';

export default async function ClientPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  return <ClientView ownerId={user.id} slug={slug} paths={APP_PATHS} readOnly={false} />;
}

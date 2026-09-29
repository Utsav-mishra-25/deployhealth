import { requireUser } from '@/auth';
import { APP_PATHS } from '@/lib/paths';
import { ClientsOverviewView } from '@/views/clients-overview';

export const dynamic = 'force-dynamic';

export default async function ClientsPage() {
  const user = await requireUser();
  return <ClientsOverviewView ownerId={user.id} paths={APP_PATHS} readOnly={false} />;
}

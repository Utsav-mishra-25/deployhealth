import { listInstallationsForUser, reposWithoutProject } from '@deployhealth/db';
import { requireUser } from '@/auth';
import { AppNextSteps } from '@/components/app-next-steps';
import { getDb } from '@/lib/db';
import { APP_PATHS } from '@/lib/paths';
import { ClientsOverviewView } from '@/views/clients-overview';

export const dynamic = 'force-dynamic';

export default async function ClientsPage() {
  const user = await requireUser();
  // Repositories the GitHub App can check for this user that have no project yet: say what to do next.
  const repos = reposWithoutProject(await listInstallationsForUser(getDb(), user.id));
  return (
    <>
      {repos.length > 0 && (
        <div className="mb-6">
          <AppNextSteps repos={repos} limit={5} />
        </div>
      )}
      <ClientsOverviewView ownerId={user.id} paths={APP_PATHS} readOnly={false} />
    </>
  );
}

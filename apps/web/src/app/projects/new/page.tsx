import { getOnboardingState, listClients, reposWithoutProject } from '@deployhealth/db';
import { requireUser } from '@/auth';
import { Breadcrumb } from '@/components/breadcrumb';
import { InstallConfirmation } from '@/components/install-confirmation';
import { serverEnv } from '@/env';
import { getDb } from '@/lib/db';
import { projectPrefill } from '@/lib/github-app';
import { installAppHref, INSTALLED_PARAM, INSTALLED_VALUE } from '@/lib/onboarding';
import { appCoverage } from '@/lib/repo-coverage';
import { NewProjectForm } from './new-project-form';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ client?: string; repo?: string; [INSTALLED_PARAM]?: string }> }) {
  const user = await requireUser();
  const params = await searchParams;
  // ?repo=owner/repo (from the GitHub App's next steps) pre-fills the form; anything else is ignored.
  const prefill = projectPrefill(params.repo);
  const db = getDb();
  const [clients, state] = await Promise.all([listClients(db, user.id), getOnboardingState(db, user.id)]);
  const preselected = clients.find((c) => c.slug === params.client)?.id ?? '';
  const coverage = appCoverage(state.installations, installAppHref(serverEnv().GITHUB_APP_SLUG, { to: 'new-project' }));
  const hasClients = clients.length > 0;

  return (
    <div>
      <Breadcrumb items={[{ label: hasClients ? 'Clients' : 'Projects', href: '/clients' }, { label: 'New project' }]} />
      <h1 className="mt-2 text-2xl font-semibold">New project</h1>
      <p className="mt-1 mb-6 text-sm text-gray-600">
        One project per GitHub repository. Once the GitHub App covers the repository, every pull request on it is checked.
      </p>
      {params[INSTALLED_PARAM] === INSTALLED_VALUE && (
        <div className="mb-6 max-w-md">
          <InstallConfirmation installations={state.installations} reloadHref={`/projects/new?${INSTALLED_PARAM}=${INSTALLED_VALUE}`} />
        </div>
      )}
      <NewProjectForm
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        // Clients are optional and offered only after the first project.
        showClient={hasClients || state.projects.length > 0}
        defaultClientId={preselected}
        defaultName={prefill?.name ?? ''}
        defaultRepoFullName={prefill?.repoFullName ?? ''}
        pickableRepos={reposWithoutProject(state.installations)}
        coverage={coverage}
      />
    </div>
  );
}

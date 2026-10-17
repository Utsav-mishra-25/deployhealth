import { getOnboardingState, reposWithoutProject } from '@deployhealth/db';
import { requireUser } from '@/auth';
import { AppNextSteps } from '@/components/app-next-steps';
import { InstallConfirmation } from '@/components/install-confirmation';
import { OnboardingChecklist } from '@/components/onboarding-checklist';
import { serverEnv } from '@/env';
import { getDb } from '@/lib/db';
import { appCoversFor, checklist, installAppHref, INSTALLED_PARAM, INSTALLED_VALUE } from '@/lib/onboarding';
import { APP_PATHS } from '@/lib/paths';
import { appCoverage } from '@/lib/repo-coverage';
import { ClientsOverviewView } from '@/views/clients-overview';

export const dynamic = 'force-dynamic';

export default async function ClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const back = (await searchParams)[INSTALLED_PARAM] === INSTALLED_VALUE;
  const appSlug = serverEnv().GITHUB_APP_SLUG;
  const state = await getOnboardingState(getDb(), user.id);
  const coverage = appCoverage(state.installations, installAppHref(appSlug, { to: 'clients' }));
  const list = checklist(state, coverage, appSlug);
  // Repositories the GitHub App can check for this user that have no project yet: say what to do next.
  const repos = reposWithoutProject(state.installations);
  return (
    <>
      {back && (
        <div className="mb-4">
          <InstallConfirmation installations={state.installations} reloadHref={`/clients?${INSTALLED_PARAM}=${INSTALLED_VALUE}`} />
        </div>
      )}
      {!list.complete && (
        <div className="mb-6">
          <OnboardingChecklist checklist={list} suggestedRepos={repos} />
        </div>
      )}
      {list.complete && repos.length > 0 && (
        <div className="mb-6">
          <AppNextSteps repos={repos} limit={5} />
        </div>
      )}
      <ClientsOverviewView ownerId={user.id} paths={APP_PATHS} readOnly={false} appCovers={appCoversFor(state.installations, appSlug)} />
    </>
  );
}

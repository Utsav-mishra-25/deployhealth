import { CLI_NPX, githubActionSnippet } from '@deployhealth/core';
import { getClientForOwner, getGithubAppStatus, getProjectForOwner, listClients, listDeploys, listInstallationsForUser } from '@deployhealth/db';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { Breadcrumb } from '@/components/breadcrumb';
import { CodeBlock } from '@/components/code-block';
import { AppStatusLine } from '@/components/github-app-status';
import { InstallConfirmation } from '@/components/install-confirmation';
import { RepoCoverageNotice } from '@/components/repo-coverage-notice';
import { SecretSteps } from '@/components/secret-steps';
import { serverEnv } from '@/env';
import { publicOrigin } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';
import { installAppHref, INSTALLED_PARAM, INSTALLED_VALUE } from '@/lib/onboarding';
import { appCoverage, repoCoverage } from '@/lib/repo-coverage';
import { DEPLOY_HISTORY_OPTION, PR_CHECKS_OPTION } from '@/lib/setup-copy';
import { PrCheckModeForm } from './pr-check-mode-form';
import { ProjectSettingsForm } from './project-settings-form';
import { RegenerateToken } from './regenerate-token';

export const dynamic = 'force-dynamic';

/**
 * A project's settings, in the setup order: pull request checks (the GitHub App, no token), then
 * the optional Action (its token, the secret, the workflow), then client, alerts and handoff.
 */
export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ [INSTALLED_PARAM]?: string }>;
}) {
  const user = await requireUser();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const db = getDb();
  const project = await getProjectForOwner(db, projectId, user.id);
  if (!project) notFound();
  const [client, clients, appStatus, installations, deploys] = await Promise.all([
    project.clientId ? getClientForOwner(db, user.id, project.clientId) : null,
    listClients(db, user.id),
    getGithubAppStatus(db, user.id, project.id),
    listInstallationsForUser(db, user.id),
    listDeploys(db, project.id, 1),
  ]);
  const appSlug = serverEnv().GITHUB_APP_SLUG;
  const installHref = installAppHref(appSlug, { to: 'settings', projectId: project.id });
  const coverage = repoCoverage(appCoverage(installations, installHref), project.repoFullName);
  const active = appStatus?.state === 'active';
  const back = (await searchParams)[INSTALLED_PARAM] === INSTALLED_VALUE;

  const url = await publicOrigin();
  const snippet = githubActionSnippet({ appUrl: url });
  const localRun = `${CLI_NPX} --dry-run`;
  const settingsPath = `/projects/${project.id}/settings`;

  return (
    <div className="max-w-3xl space-y-10">
      <div className="space-y-4">
        <div>
          <Breadcrumb
            items={[
              { label: client || clients.length > 0 ? 'Clients' : 'Projects', href: '/clients' },
              ...(client
                ? [{ label: client.name, href: `/clients/${client.slug}` }]
                : clients.length > 0
                  ? [{ label: 'No client', href: '/clients#no-client' }]
                  : []),
              { label: project.name, href: `/projects/${project.id}` },
              { label: 'Settings' },
            ]}
          />
          <h1 className="mt-2 text-2xl font-semibold">Settings</h1>
        </div>
        {back && <InstallConfirmation installations={installations} reloadHref={`${settingsPath}?${INSTALLED_PARAM}=${INSTALLED_VALUE}`} />}
      </div>

      <section aria-labelledby="pr-checks" className="scroll-mt-4">
        <h2 id="pr-checks" className="text-lg font-semibold">
          {PR_CHECKS_OPTION.title}
        </h2>
        <p className="mt-1 text-sm text-gray-600" data-testid="pr-checks-option">
          {PR_CHECKS_OPTION.body}
        </p>
        <p className="mt-2 mb-3 text-sm text-gray-600">
          The GitHub App checks every pull request on <strong className="break-all">{project.repoFullName}</strong>: which env vars it adds, removes or
          renames, new ones missing from <code>.env.example</code>, committed <code>.env</code> files and secret-shaped strings. It
          comments once per pull request and adds a <code>deployhealth / env</code> check. Names and file:line only, never values.
        </p>
        <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
          {/* Installed elsewhere but not on this repository: the notice says why and where to fix it. */}
          {appStatus?.state === 'not-installed' && installations.length > 0 && coverage.state !== 'no-app' ? (
            <RepoCoverageNotice coverage={coverage} repo={project.repoFullName} />
          ) : (
            <AppStatusLine status={appStatus!} repo={project.repoFullName} />
          )}
          {/* The notice above links to the fix when the App is installed elsewhere; otherwise install or manage it here. */}
          {installHref && !(appStatus?.state === 'not-installed' && installations.length > 0) ? (
            <a
              href={installHref}
              className="inline-block rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
              data-testid="install-github-app"
            >
              {appStatus?.state === 'not-installed' ? 'Install the GitHub App' : 'Manage the GitHub App'}
            </a>
          ) : (
            !installHref && <p className="text-sm text-gray-500">The GitHub App isn&apos;t configured on this deployment (GITHUB_APP_SLUG).</p>
          )}
          {!active && (
            <p className="text-sm text-gray-600" data-testid="mode-pending">
              The mode below takes effect once the App covers this repository.
            </p>
          )}
          <PrCheckModeForm projectId={project.id} mode={project.prCheckMode} />
        </div>
      </section>

      <section aria-labelledby="deploy-history" className="scroll-mt-4 space-y-6">
        <div>
          <h2 id="deploy-history" className="text-lg font-semibold">
            {DEPLOY_HISTORY_OPTION.title}
          </h2>
          <p className="mt-1 text-sm text-gray-600" data-testid="deploy-history-option">
            {DEPLOY_HISTORY_OPTION.body} Pull request checks don&apos;t need it.
          </p>
        </div>

        <div>
          <h3 className="font-semibold">Token</h3>
          {deploys.length === 0 ? (
            <p className="mt-1 text-sm text-gray-600">
              No deploy reported yet. Create the token, save it as the repository secret, then add the workflow below.
            </p>
          ) : (
            <p className="mt-1 text-sm text-gray-600">
              Current token: <code className="font-mono">{project.apiTokenHint}</code>. Tokens are stored hashed, so a lost token can only
              be replaced.
            </p>
          )}
          <RegenerateToken projectId={project.id} repo={project.repoFullName} first={deploys.length === 0} />
        </div>

        <div>
          <h3 className="font-semibold">GitHub Action</h3>
          <div className="text-sm">
            <SecretSteps repo={project.repoFullName} />
          </div>
          <p className="mt-3 mb-3 text-sm text-gray-600">
            Then add this workflow to <strong className="break-all">{project.repoFullName}</strong>:
          </p>
          <CodeBlock code={snippet} label=".github/workflows/deployhealth.yml" />
        </div>

        <div>
          <h3 className="font-semibold">Try the scan locally first</h3>
          <p className="mt-1 mb-3 text-sm text-gray-600">
            Prints what the Action would report, without sending anything. Add <code>--ignore</code> or <code>--exclude</code> to narrow
            it down.
          </p>
          <CodeBlock code={localRun} label="shell" />
        </div>
      </section>

      <section aria-labelledby="client-alerts">
        <h2 id="client-alerts" className="text-lg font-semibold">
          Client, alerts &amp; handoff
        </h2>
        <p className="mt-1 mb-3 text-sm text-gray-600">
          Group this project under a client (optional), choose where alerts are sent, and write down how it deploys.
        </p>
        <ProjectSettingsForm
          projectId={project.id}
          clients={clients.map((c) => ({ id: c.id, name: c.name }))}
          clientId={project.clientId}
          alertWebhookUrl={project.alertWebhookUrl}
          deployNotes={project.deployNotes}
        />
      </section>
    </div>
  );
}

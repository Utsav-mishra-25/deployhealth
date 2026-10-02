import { CLI_NPX, githubActionSnippet } from '@deployhealth/core';
import { getClientForOwner, getGithubAppStatus, getProjectForOwner, listClients, type GithubAppStatus } from '@deployhealth/db';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { Breadcrumb } from '@/components/breadcrumb';
import { CodeBlock } from '@/components/code-block';
import { SecretSteps } from '@/components/secret-steps';
import { serverEnv } from '@/env';
import { appUrl } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';
import { DEPLOY_HISTORY_OPTION, PR_CHECKS_OPTION } from '@/lib/setup-copy';
import { PrCheckModeForm } from './pr-check-mode-form';
import { ProjectSettingsForm } from './project-settings-form';
import { RegenerateToken } from './regenerate-token';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireUser();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const db = getDb();
  const project = await getProjectForOwner(db, projectId, user.id);
  if (!project) notFound();
  const [client, clients, appStatus] = await Promise.all([
    project.clientId ? getClientForOwner(db, user.id, project.clientId) : null,
    listClients(db, user.id),
    getGithubAppStatus(db, user.id, project.id),
  ]);
  const appSlug = serverEnv().GITHUB_APP_SLUG;

  const url = await appUrl();
  const snippet = githubActionSnippet({ appUrl: url });
  const localRun = `${CLI_NPX} --dry-run`;

  return (
    <div className="max-w-3xl space-y-10">
      <div>
        <Breadcrumb
          items={[
            { label: 'Clients', href: '/clients' },
            client ? { label: client.name, href: `/clients/${client.slug}` } : { label: 'No client', href: '/clients#no-client' },
            { label: project.name, href: `/projects/${project.id}` },
            { label: 'Settings' },
          ]}
        />
        <h1 className="mt-2 text-2xl font-semibold">Settings</h1>
      </div>

      <section>
        <h2 className="text-lg font-semibold">Client, alerts &amp; handoff</h2>
        <p className="mt-1 mb-3 text-sm text-gray-600">
          Group this project under a client, choose where alerts are sent, and write down how it deploys.
        </p>
        <ProjectSettingsForm
          projectId={project.id}
          clients={clients.map((c) => ({ id: c.id, name: c.name }))}
          clientId={project.clientId}
          alertWebhookUrl={project.alertWebhookUrl}
          deployNotes={project.deployNotes}
        />
      </section>

      <section aria-labelledby="pr-checks">
        <h2 id="pr-checks" className="text-lg font-semibold">
          {PR_CHECKS_OPTION.title}
        </h2>
        <p className="mt-1 text-sm text-gray-600" data-testid="pr-checks-option">
          {PR_CHECKS_OPTION.body}
        </p>
        <p className="mt-2 mb-3 text-sm text-gray-600">
          The GitHub App checks every pull request on <strong>{project.repoFullName}</strong>: which env vars it adds, removes or
          renames, new ones missing from <code>.env.example</code>, committed <code>.env</code> files and secret-shaped strings. It
          comments once per pull request and adds a <code>deployhealth / env</code> check. Names and file:line only, never values.
        </p>
        <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
          <AppStatusLine status={appStatus!} repo={project.repoFullName} />
          {appSlug ? (
            <a
              href={`https://github.com/apps/${appSlug}/installations/new`}
              className="inline-block rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
              data-testid="install-github-app"
            >
              {appStatus?.state === 'active' ? 'Manage the GitHub App' : 'Install the GitHub App'}
            </a>
          ) : (
            <p className="text-sm text-gray-500">The GitHub App isn&apos;t configured on this deployment (GITHUB_APP_SLUG).</p>
          )}
          <PrCheckModeForm projectId={project.id} mode={project.prCheckMode} />
        </div>
      </section>

      <section aria-labelledby="deploy-history" className="space-y-6">
        <div>
          <h2 id="deploy-history" className="text-lg font-semibold">
            {DEPLOY_HISTORY_OPTION.title}
          </h2>
          <p className="mt-1 text-sm text-gray-600" data-testid="deploy-history-option">
            {DEPLOY_HISTORY_OPTION.body}
          </p>
        </div>

        <div>
          <h3 className="font-semibold">Ingest token</h3>
          <p className="mt-1 text-sm text-gray-600">
            Current token: <code className="font-mono">{project.apiTokenHint}</code>. Tokens are stored hashed, so a lost
            token can only be replaced.
          </p>
          <RegenerateToken projectId={project.id} />
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
      </section>

      <section>
        <h2 className="text-lg font-semibold">Try it locally</h2>
        <p className="mt-1 mb-3 text-sm text-gray-600">
          Prints what the Action would report, without sending anything. Add <code>--ignore</code> or{' '}
          <code>--exclude</code> to narrow it down.
        </p>
        <CodeBlock code={localRun} label="shell" />
      </section>
    </div>
  );
}

function AppStatusLine({ status, repo }: { status: GithubAppStatus; repo: string }) {
  const text = {
    'not-installed': <>Not installed on {repo} yet.</>,
    active: (
      <>
        <span className="font-medium text-emerald-700">Installed</span> on {'accountLogin' in status && status.accountLogin}: pull requests on {repo} are
        checked.
      </>
    ),
    suspended: (
      <>
        <span className="font-medium text-amber-700">Suspended</span> on {'accountLogin' in status && status.accountLogin}. Unsuspend it in GitHub&apos;s
        settings to resume checks.
      </>
    ),
    'other-account': (
      <>
        Installed on {'accountLogin' in status && status.accountLogin}, but by a GitHub account other than yours, so this project&apos;s pull
        requests aren&apos;t checked. Install it yourself (you need admin rights on the repository), or sign in with the account that did.
      </>
    ),
  }[status.state];
  return (
    <p className="text-sm text-gray-700" data-testid="github-app-status">
      {text}
    </p>
  );
}

import { getOnboardingState, getProjectForOwner, reposWithoutProject } from '@deployhealth/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { AppNextSteps } from '@/components/app-next-steps';
import { RepoCoverageNotice } from '@/components/repo-coverage-notice';
import { SetupOrder } from '@/components/setup-order';
import { serverEnv } from '@/env';
import { getDb } from '@/lib/db';
import { GITHUB_INSTALLED_PATH, newProjectHref, signInHref } from '@/lib/github-app';
import { installAppHref, installReturnPath, parseInstallState } from '@/lib/onboarding';
import { appCoverage, repoCoverage } from '@/lib/repo-coverage';

export const metadata: Metadata = { title: 'GitHub App installed · deployhealth' };
export const dynamic = 'force-dynamic';

/**
 * Where GitHub sends people after installing or configuring the App (its Setup URL). Signed in,
 * a `state` from deployhealth's own install links (`parseInstallState`: a fixed allowlist) sends
 * them back to the page they started from; anything else shows this page: what's linked to this
 * account, each repository without a project, and the user's projects the App doesn't cover.
 * Signed out, it says to sign in and come back. The other query parameters GitHub adds
 * (installation_id) are deliberately ignored: installations are linked only from signed webhook
 * deliveries, by the installer's GitHub id.
 */
export default async function GithubInstalledPage({ searchParams }: { searchParams: Promise<{ state?: string | string[] }> }) {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-2xl font-semibold">GitHub App</h1>
        <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700" data-testid="installed-signed-out">
          <p>
            Thanks for installing the App. Sign in to deployhealth with the GitHub account you installed it with, then come back to
            this page: it lists the repositories the App can see and how to start pull request checks for each.
          </p>
          <p className="mt-3">
            <Link href={signInHref(GITHUB_INSTALLED_PATH)} className="inline-block rounded-md bg-gray-900 px-3 py-2 font-medium text-white hover:bg-gray-700">
              Sign in and come back
            </Link>
          </p>
        </div>
        <SetupOrder />
      </div>
    );
  }

  const db = getDb();
  const ret = parseInstallState((await searchParams).state);
  if (ret) {
    // Only the user's own project: another user's id (or a deleted one) is a 404, never a redirect.
    if (ret.to === 'settings' && !(await getProjectForOwner(db, ret.projectId, userId))) notFound();
    redirect(installReturnPath(ret));
  }

  const state = await getOnboardingState(db, userId);
  const installations = state.installations;
  const missing = reposWithoutProject(installations);
  const coverage = appCoverage(installations, installAppHref(serverEnv().GITHUB_APP_SLUG, { to: 'clients' }));
  const uncovered = state.projects.map((p) => ({ ...p, coverage: repoCoverage(coverage, p.repoFullName) })).filter((p) => p.coverage.state !== 'covered' && p.coverage.state !== 'no-app');

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">GitHub App</h1>
      <AppNextSteps repos={missing} />
      {installations.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700" data-testid="installations-empty">
          GitHub is still telling deployhealth about the installation; reload in a few seconds. If nothing shows up, check that you
          installed it with the GitHub account you sign in with here.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="installations">
          {installations.map((i) => (
            <li key={i.accountLogin} className="rounded-lg border border-gray-200 bg-white p-4 text-sm">
              <p className="font-medium">
                {i.accountLogin} <span className="font-normal text-gray-500">({i.accountType === 'Organization' ? 'organization' : 'personal account'})</span>
                {i.suspended && <span className="ml-2 text-amber-700">suspended</span>}
              </p>
              {i.repositorySelection === 'all' && (
                <p className="mt-1 text-gray-600" data-testid="all-repositories">
                  All repositories of {i.accountLogin}, including new ones.
                </p>
              )}
              {i.repos.length === 0 ? (
                i.repositorySelection !== 'all' && <p className="mt-1 text-gray-600">No repositories selected.</p>
              ) : (
                <ul className="mt-2 space-y-1 text-gray-700">
                  {i.repos.map((r) => (
                    <li key={r.fullName} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono break-all">{r.fullName}</span>
                      {r.projectId ? (
                        <Link href={`/projects/${r.projectId}`} className="text-emerald-700 hover:underline">
                          project
                        </Link>
                      ) : i.suspended ? (
                        <span className="text-gray-500">no project</span>
                      ) : (
                        <Link href={newProjectHref(r.fullName)} className="text-emerald-700 hover:underline">
                          add a project
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {uncovered.length > 0 && (
        <section id="not-covered" aria-labelledby="not-covered-title" className="scroll-mt-4 space-y-3" data-testid="not-covered">
          <h2 id="not-covered-title" className="text-lg font-semibold">
            Your projects the App doesn&apos;t cover
          </h2>
          <p className="text-sm text-gray-600">Their pull requests get no deployhealth check until the App can see the repository.</p>
          <ul className="space-y-3">
            {uncovered.map((p) => (
              <li key={p.id} className="space-y-2">
                <p className="text-sm">
                  <Link href={`/projects/${p.id}`} className="font-medium text-gray-900 hover:text-emerald-700">
                    {p.name}
                  </Link>{' '}
                  <span className="font-mono text-xs break-all text-gray-500">{p.repoFullName}</span>
                </p>
                <RepoCoverageNotice coverage={p.coverage} repo={p.repoFullName} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-sm text-gray-600">
        Pull requests are checked for your projects whose repository is one of these. Each project&apos;s mode (off, comment or strict)
        is in its settings. <Link href="/clients" className="font-medium text-emerald-700 hover:underline">Back to your projects</Link>
      </p>
      <SetupOrder />
    </div>
  );
}

import { listInstallationsForUser, reposWithoutProject } from '@deployhealth/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { auth } from '@/auth';
import { AppNextSteps } from '@/components/app-next-steps';
import { getDb } from '@/lib/db';
import { GITHUB_INSTALLED_PATH, newProjectHref, signInHref } from '@/lib/github-app';

export const metadata: Metadata = { title: 'GitHub App installed · deployhealth' };
export const dynamic = 'force-dynamic';

/**
 * Where GitHub sends people after installing or configuring the App (its Setup URL). Shows what's
 * linked to this account and, for each repository without a project, how to add one. Signed out,
 * it says to sign in and come back. The query string GitHub adds (installation_id) is deliberately
 * ignored: installations are linked only from signed webhook deliveries, by the installer's GitHub id.
 */
export default async function GithubInstalledPage() {
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
      </div>
    );
  }

  const installations = await listInstallationsForUser(getDb(), userId);
  const missing = reposWithoutProject(installations);

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
              {i.repos.length === 0 ? (
                <p className="mt-1 text-gray-600">No repositories selected.</p>
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
      <p className="text-sm text-gray-600">
        Pull requests are checked for your projects whose repository is one of these. Each project&apos;s mode (off, comment or strict)
        is in its settings. <Link href="/clients" className="font-medium text-emerald-700 hover:underline">Back to your clients</Link>
      </p>
    </div>
  );
}

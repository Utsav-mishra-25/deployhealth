import { listInstallationsForUser } from '@deployhealth/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser } from '@/auth';
import { getDb } from '@/lib/db';

export const metadata: Metadata = { title: 'GitHub App installed · deployhealth' };
export const dynamic = 'force-dynamic';

/**
 * Where GitHub sends people after installing or configuring the App (its Setup URL). Shows what's
 * linked to this account. The query string GitHub adds (installation_id) is deliberately ignored:
 * installations are linked only from signed webhook deliveries, by the installer's GitHub id.
 */
export default async function GithubInstalledPage() {
  const user = await requireUser();
  const installations = await listInstallationsForUser(getDb(), user.id);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">GitHub App</h1>
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
              <p className="mt-1 text-gray-600">
                {i.repos.length === 0 ? 'No repositories selected.' : `${i.repos.length} repositor${i.repos.length === 1 ? 'y' : 'ies'}: ${i.repos.join(', ')}`}
              </p>
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

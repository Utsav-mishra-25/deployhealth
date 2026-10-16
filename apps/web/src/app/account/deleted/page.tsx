import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Account deleted · deployhealth', robots: { index: false } };

/** Where a browser lands after its account is deleted (or a session outlived its account). Public: it's signed out. */
export default function AccountDeletedPage() {
  return (
    <div className="max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Your account has been deleted</h1>
      <p className="text-gray-700">
        Your deployhealth account and everything it held are gone: clients, projects, deploy and scan history, endpoints and
        their checks, alerts, and pull request checks. You&apos;ve been signed out.
      </p>
      <p className="text-gray-700">
        If you installed the deployhealth GitHub App, uninstall it on GitHub (Settings → Applications → Installed GitHub Apps,
        and in each organization&apos;s settings): deployhealth can&apos;t remove it for you, and until you do, GitHub keeps
        sending its events, which are discarded.
      </p>
      <p className="text-gray-700">Signing in again creates a new, empty account.</p>
      <p>
        <Link href="/" className="text-emerald-700 underline hover:text-emerald-800">
          Back to the home page
        </Link>
      </p>
    </div>
  );
}

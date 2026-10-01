import Link from 'next/link';
import { GITHUB_INSTALLED_PATH, newProjectHref } from '@/lib/github-app';

/**
 * Repositories the GitHub App can see that have no project yet, each with a link to add one
 * (pre-filled). With `limit`, the rest are summarized with a link to the GitHub App page.
 */
export function AppNextSteps({ repos, limit }: { repos: readonly string[]; limit?: number }) {
  if (repos.length === 0) return null;
  const shown = limit === undefined ? repos : repos.slice(0, limit);
  const more = repos.length - shown.length;
  return (
    <section aria-labelledby="app-next-steps-title" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-gray-800" data-testid="app-next-steps">
      <h2 id="app-next-steps-title" className="font-medium text-emerald-900">
        Next: add a project for {repos.length === 1 ? 'this repository' : 'these repositories'}
      </h2>
      <p className="mt-1 text-gray-700">
        The GitHub App can see {repos.length === 1 ? 'it' : 'them'}, but pull requests are only checked for repositories with a project.
      </p>
      <ul className="mt-2 space-y-1">
        {shown.map((repo) => (
          <li key={repo}>
            <Link href={newProjectHref(repo)} className="font-medium text-emerald-700 hover:underline">
              Add a project for <span className="font-mono break-all">{repo}</span>
            </Link>{' '}
            to start pull request checks
          </li>
        ))}
      </ul>
      {more > 0 && (
        <p className="mt-2 text-gray-700">
          And {more} more on the{' '}
          <Link href={GITHUB_INSTALLED_PATH} className="font-medium text-emerald-700 hover:underline">
            GitHub App page
          </Link>
          .
        </p>
      )}
    </section>
  );
}

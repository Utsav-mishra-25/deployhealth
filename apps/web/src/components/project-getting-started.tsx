import type { PrCheckMode } from '@deployhealth/db';
import Link from 'next/link';
import type { RepoCoverage } from '@/lib/repo-coverage';
import { RepoCoverageNotice } from './repo-coverage-notice';

/** One row of the panel: what will appear, and when. */
function Item({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid={testId}>
      <h3 className="font-medium text-gray-900">{title}</h3>
      <div className="mt-1 space-y-2 text-sm text-gray-600">{children}</div>
    </li>
  );
}

/**
 * A project before its first scan: what shows up on this page and what makes it appear, instead
 * of empty tables. Pull request checks first (the App, no token), then sites, then the optional
 * Action. Signed-in only (the demo always has data).
 */
export function ProjectGettingStarted({
  projectId,
  repo,
  coverage,
  prCheckMode,
  prChecks,
  endpoints,
}: {
  projectId: string;
  repo: string;
  coverage: RepoCoverage;
  prCheckMode: PrCheckMode;
  prChecks: number;
  endpoints: number;
}) {
  const settings = `/projects/${projectId}/settings`;
  const link = 'font-medium text-emerald-700 hover:underline';
  return (
    <section aria-labelledby="getting-started" className="rounded-lg border border-gray-200 bg-white p-4 sm:p-5" data-testid="project-getting-started">
      <h2 id="getting-started" className="text-lg font-semibold">
        What shows up here
      </h2>
      <ul className="mt-3 divide-y divide-gray-100">
        <Item title="Pull request checks" testId="getting-started-prs">
          {prChecks > 0 ? (
            <p>
              Pull requests on <span className="break-all">{repo}</span> are being checked:{' '}
              <a href="#pull-requests" className={link}>
                see them below
              </a>
              .
            </p>
          ) : prCheckMode === 'off' ? (
            <p>
              Pull request checks are off for this project.{' '}
              <Link href={`${settings}#pr-checks`} className={link}>
                Turn them on in Settings
              </Link>
              .
            </p>
          ) : coverage.state === 'covered' ? (
            <p>
              Open a pull request on <span className="break-all">{repo}</span> to see the first check: a comment and a{' '}
              <code>deployhealth / env</code> check on GitHub, listed here too.
            </p>
          ) : coverage.state === 'no-app' ? (
            <p>The GitHub App isn&apos;t set up on this deployment, so pull requests aren&apos;t checked here.</p>
          ) : (
            <RepoCoverageNotice coverage={coverage} repo={repo} />
          )}
        </Item>
        <Item title="Uptime" testId="getting-started-sites">
          {endpoints === 0 ? (
            <p>
              <a href="#add-endpoint" className={link}>
                Add a site (a URL to watch)
              </a>
              : deployhealth requests it on a schedule and alerts you when it fails.
            </p>
          ) : (
            <p>Your sites are listed below; each one&apos;s first check runs within its interval.</p>
          )}
        </Item>
        <Item title="Optional: deploy history" testId="getting-started-action">
          <p>
            <Link href={`${settings}#deploy-history`} className={link}>
              Add the Action
            </Link>{' '}
            for deploy history: each push&apos;s env check, and alerts that name the deploy.
          </p>
        </Item>
      </ul>
    </section>
  );
}

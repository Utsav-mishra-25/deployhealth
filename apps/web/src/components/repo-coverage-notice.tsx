import type { RepoCoverage } from '@/lib/repo-coverage';

const LINK = 'font-medium underline underline-offset-2 hover:text-amber-900';

/**
 * What to do when the user's GitHub App installations don't cover a repository (pull requests
 * there get no check, "Checks 0" on GitHub). Nothing when covered or when the App isn't configured.
 * No hooks or state: rendered on the server and in the new-project form.
 */
export function RepoCoverageNotice({ coverage, repo }: { coverage: RepoCoverage; repo: string }) {
  if (coverage.state === 'covered' || coverage.state === 'no-app') return null;
  const name = <strong className="font-semibold break-all">{repo}</strong>;
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="repo-coverage" data-state={coverage.state}>
      {coverage.state === 'suspended' && (
        <p>
          The GitHub App is suspended on {coverage.account.login}, so pull requests on {name} aren&apos;t checked.{' '}
          <a href={coverage.account.settingsUrl} className={LINK}>
            Unsuspend it on GitHub
          </a>
          .
        </p>
      )}
      {coverage.state === 'not-selected' && (
        <p>
          The GitHub App is installed on {coverage.account.login}, but not on {name}, so its pull requests aren&apos;t checked. On GitHub, open{' '}
          <a href={coverage.account.settingsUrl} className={LINK}>
            the App&apos;s settings for {coverage.account.login}
          </a>{' '}
          → Repository access, and select this repository (or All repositories).
        </p>
      )}
      {coverage.state === 'not-installed' && (
        <p>
          {coverage.installedOn.length === 0 ? (
            <>The GitHub App isn&apos;t installed yet, so pull requests on {name} aren&apos;t checked. </>
          ) : (
            <>
              The GitHub App is installed on {coverage.installedOn.join(', ')}, but not on {coverage.owner}, so pull requests on {name} aren&apos;t checked.{' '}
            </>
          )}
          <a href={coverage.installUrl} className={LINK}>
            Install the GitHub App{coverage.installedOn.length === 0 ? '' : ` on ${coverage.owner}`}
          </a>{' '}
          and select this repository.
        </p>
      )}
    </div>
  );
}

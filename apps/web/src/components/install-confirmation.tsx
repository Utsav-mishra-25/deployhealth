import type { InstallationSummary } from '@deployhealth/db';
import { plural } from '@deployhealth/core/browser';

/** "acme (2 repositories)", "utsav (all repositories)". */
function covers(i: InstallationSummary): string {
  return `${i.accountLogin} (${i.repositorySelection === 'all' ? 'all repositories' : plural(i.repos.length, 'repository', 'repositories')})`;
}

/**
 * One line on the page the user came back to after installing the App (`?app=installed`). It reads
 * only the user's own installations: the query flag alone never claims an installation exists.
 */
export function InstallConfirmation({ installations, reloadHref }: { installations: readonly InstallationSummary[]; reloadHref: string }) {
  const active = installations.filter((i) => !i.suspended);
  return (
    <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900" data-testid="install-confirmation">
      {active.length > 0 ? (
        <>GitHub App installed on {active.map(covers).join(', ')}.</>
      ) : (
        <>
          Back from GitHub. The installation can take a few seconds to reach deployhealth:{' '}
          <a href={reloadHref} className="font-medium underline underline-offset-2">
            reload this page
          </a>
          .
        </>
      )}
    </p>
  );
}

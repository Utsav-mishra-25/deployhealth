import type { GithubAppStatus } from '@deployhealth/db';

/** Only the user's own installations reach this (getGithubAppStatus): anyone else's reads as not installed. */
export function AppStatusLine({ status, repo }: { status: GithubAppStatus; repo: string }) {
  const text = {
    'not-installed': <>Not installed by you on {repo}.</>,
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
  }[status.state];
  return (
    <p className="text-sm text-gray-700" data-testid="github-app-status">
      {text}
    </p>
  );
}

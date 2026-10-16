import type { InstallationSummary } from '@deployhealth/db';

// Whether the user's own GitHub App installations cover a repository, and what to do if not.
// Browser-safe (type-only imports): the new-project form checks the typed repository as you go.

/** One of the user's installations, as the coverage notes need it. */
export interface CoverageAccount {
  login: string;
  /** GitHub's settings page for the installation, where "Repository access" is changed. */
  settingsUrl: string;
  /** "All repositories": every repository of `login`, whether deployhealth has a row for it or not. */
  all: boolean;
  suspended: boolean;
  /** The repositories it lists, lowercased. */
  repos: string[];
}

/** The user's installations plus where to install the App (null: not configured on this deployment). */
export interface AppCoverage {
  installUrl: string | null;
  accounts: CoverageAccount[];
}

export type RepoCoverage =
  /** An active installation can check it. */
  | { state: 'covered'; account: CoverageAccount }
  /** Only a suspended installation can. */
  | { state: 'suspended'; account: CoverageAccount }
  /** Installed on the repository's owner account, but the repository isn't selected. */
  | { state: 'not-selected'; account: CoverageAccount }
  /** Not installed on the repository's owner account (maybe on others). */
  | { state: 'not-installed'; installUrl: string; owner: string; installedOn: string[] }
  /** No GitHub App on this deployment (GITHUB_APP_SLUG unset): nothing to say. */
  | { state: 'no-app' };

/**
 * GitHub's settings page for an installation: under the organization for an organization's, under
 * the user's settings otherwise. "Repository access" is on that page.
 */
export function installationSettingsUrl(i: Pick<InstallationSummary, 'githubInstallationId' | 'accountLogin' | 'accountType'>): string {
  return i.accountType === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(i.accountLogin)}/settings/installations/${i.githubInstallationId}`
    : `https://github.com/settings/installations/${i.githubInstallationId}`;
}

/** The coverage data for the user's own installations (`listInstallationsForUser`), never anyone else's. */
export function appCoverage(installations: readonly InstallationSummary[], installUrl: string | null): AppCoverage {
  return {
    installUrl,
    accounts: installations.map((i) => ({
      login: i.accountLogin,
      settingsUrl: installationSettingsUrl(i),
      all: i.repositorySelection === 'all',
      suspended: i.suspended,
      repos: i.repos.map((r) => r.fullName.toLowerCase()),
    })),
  };
}

/**
 * Whether the App can check `repo` (owner/repo, case-insensitive) for this user: an installation
 * listing it, or one with "All repositories" on its owner account. The same rule as the database's
 * (`getGithubAppStatus`, `findPrCheckTarget`).
 */
export function repoCoverage(coverage: AppCoverage, repo: string): RepoCoverage {
  const name = repo.trim().toLowerCase();
  const owner = name.slice(0, Math.max(0, name.indexOf('/')));
  const covers = (a: CoverageAccount) => (a.all && a.login.toLowerCase() === owner) || a.repos.includes(name);
  const active = coverage.accounts.find((a) => !a.suspended && covers(a));
  if (active) return { state: 'covered', account: active };
  const suspended = coverage.accounts.find(covers);
  if (suspended) return { state: 'suspended', account: suspended };
  if (!coverage.installUrl) return { state: 'no-app' };
  const onOwner = coverage.accounts.find((a) => a.login.toLowerCase() === owner);
  if (onOwner) return { state: 'not-selected', account: onOwner };
  return { state: 'not-installed', installUrl: coverage.installUrl, owner: repo.trim().slice(0, owner.length), installedOn: coverage.accounts.map((a) => a.login) };
}

/** For "Not set up"'s reason on project lists: true/false, or undefined when the App isn't configured. */
export function coversRepo(coverage: AppCoverage): (repo: string) => boolean | undefined {
  return (repo) => {
    const state = repoCoverage(coverage, repo).state;
    return state === 'no-app' ? undefined : state === 'covered';
  };
}

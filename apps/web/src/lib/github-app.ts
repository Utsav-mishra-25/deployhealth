// Next steps after installing the GitHub App: a project per repository, pre-filled from a link.

/** "owner/repo", as GitHub names repositories (also what a new project's form accepts). */
export const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** The new-project form, pre-filled for `repo`. */
export function newProjectHref(repo: string): string {
  return `/projects/new?repo=${encodeURIComponent(repo)}`;
}

/** What the new-project form starts with for `?repo=`: the repo and its name as the project name. Null if it isn't owner/repo. */
export function projectPrefill(repo: string | undefined): { repoFullName: string; name: string } | null {
  if (!repo || !REPO_FULL_NAME_PATTERN.test(repo)) return null;
  return { repoFullName: repo, name: repo.slice(repo.indexOf('/') + 1).slice(0, 64) };
}

/**
 * Where to go after signing in, from `?next=`: only a path on this site (letters, digits, `/`,
 * `-`, `_`), never another origin (`//host`, `https://…`, backslashes) or a query string.
 */
export function safeReturnPath(next: string | undefined): string | null {
  return next && /^\/(?![/\\])[A-Za-z0-9/_-]*$/.test(next) ? next : null;
}

/** The sign-in page, coming back to `path` afterwards. */
export function signInHref(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

export const GITHUB_INSTALLED_PATH = '/github/installed';

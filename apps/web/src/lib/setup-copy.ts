import { TOKEN_SECRET_NAME } from '@deployhealth/core/browser';

// Setup, worded once: the project settings page and its token reveal (a client component, hence
// browser-safe imports only) use these. The order matches the landing page: pull request checks
// with the App (no token), then, optionally, deploy history with the Action and its token.

export const PR_CHECKS_OPTION = {
  title: 'Pull request checks (GitHub App)',
  body: 'Install the deployhealth GitHub App on the repository and add a project for its exact owner/repo. No token, no secret, no variable.',
} as const;

export const DEPLOY_HISTORY_OPTION = {
  title: 'Optional: deploy history (GitHub Action)',
  body: `Add the GitHub Action to the repository for deploy history and alerts that name the deploy. It reports each push with this project's token, saved as a repository secret named ${TOKEN_SECRET_NAME}.`,
} as const;

/** Where the secret goes, step by step, and the two places it must not go. */
export const SECRET_STEPS = {
  path: ['Settings', 'Secrets and variables', 'Actions', 'Secrets tab', 'New repository secret'],
  name: TOKEN_SECRET_NAME,
  notVariable: 'Not a Variable: the Variables tab shows values in plain text to anyone with access to the repository.',
  notEnvironment: 'Not an environment secret: the workflow declares no environment, so it wouldn’t see one.',
} as const;

/** The token box's heading: the plaintext appears this once, in settings, when it's created. */
export const TOKEN_ONCE = 'Save this token as the repository secret now: it appears only here, this once.';

import { TOKEN_SECRET_NAME } from '@deployhealth/core/browser';

// The two ways to set up a project, worded once: the settings page, the screen after creating a
// project (a client component, hence browser-safe imports only) and /github/installed use these.

export const PR_CHECKS_OPTION = {
  title: 'Pull request checks',
  body: 'Install the deployhealth GitHub App on the repository and add a project for its exact owner/repo. No token, no secret, no variable.',
} as const;

export const DEPLOY_HISTORY_OPTION = {
  title: 'Deploy history and alerts',
  body: `Add the GitHub Action to the repository, with the project's ingest token saved as a repository secret named ${TOKEN_SECRET_NAME}.`,
} as const;

/** Where the secret goes, step by step, and the two places it must not go. */
export const SECRET_STEPS = {
  path: ['Settings', 'Secrets and variables', 'Actions', 'Secrets tab', 'New repository secret'],
  name: TOKEN_SECRET_NAME,
  notVariable: 'Not a Variable: the Variables tab shows values in plain text to anyone with access to the repository.',
  notEnvironment: 'Not an environment secret: the workflow declares no environment, so it wouldn’t see one.',
} as const;

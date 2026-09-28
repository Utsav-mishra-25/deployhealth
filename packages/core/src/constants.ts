// Browser-safe constants (no Node imports), shared by the CLI, the server and client components.

export const TOKEN_PREFIX = 'dh_';

/** Name of the repository secret the GitHub Actions snippet expects. */
export const TOKEN_SECRET_NAME = 'DEPLOYHEALTH_TOKEN';

/** Path (on the web app) of the single-file CLI bundle the snippet downloads. */
export const CLI_BUNDLE_PATH = '/deployhealth-scan.mjs';

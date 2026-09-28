// Browser-safe constants (no Node imports), shared by the CLI, the server and client components.

export const TOKEN_PREFIX = 'dh_';

/** Name of the repository secret the GitHub Actions snippet expects. */
export const TOKEN_SECRET_NAME = 'DEPLOYHEALTH_TOKEN';

/** Path (on the web app) of the single-file CLI bundle the snippet downloads. */
export const CLI_BUNDLE_PATH = '/deployhealth-scan.mjs';

/** Allowed check intervals, in seconds (mirrored by a CHECK constraint on endpoints). */
export const ENDPOINT_INTERVALS = [60, 300, 900] as const;
export type EndpointInterval = (typeof ENDPOINT_INTERVALS)[number];

export const ENDPOINT_METHODS = ['GET', 'HEAD'] as const;
export type EndpointMethod = (typeof ENDPOINT_METHODS)[number];

/** Consecutive failed checks that open an alert (only after the endpoint has had an ok check). */
export const ALERT_FAILURE_THRESHOLD = 2;

/** An alert links the most recent deploy within this window before the first failed check. */
export const DEPLOY_LINK_WINDOW_MINUTES = 30;

/** Checks older than this are deleted nightly. */
export const CHECK_RETENTION_DAYS = 30;

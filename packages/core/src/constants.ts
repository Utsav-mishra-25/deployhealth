// Browser-safe constants (no Node imports), shared by the CLI, the server and client components.

export const TOKEN_PREFIX = 'dh_';

/** Name of the repository secret the GitHub Actions snippet expects. */
export const TOKEN_SECRET_NAME = 'DEPLOYHEALTH_TOKEN';

/** The CLI's npm package, and the exact version snippets and docs pin. */
export const CLI_NPM_PACKAGE = 'deployhealth-scan';
/** Bump only after that version is on npm (it can trail src/version.ts while a release is pending). */
export const PUBLISHED_CLI_VERSION = '0.2.0';

/**
 * Deprecated: the single-file CLI bundle the web app still serves at this path, for workflows
 * written before the npm package. Served with a Deprecation header; removal is a later phase.
 */
export const CLI_BUNDLE_PATH = '/deployhealth-scan.mjs';

/**
 * The bundled CLI's size, rounded to whole KB, as the landing page states it ("16 KB, zero
 * dependencies"). test/npm-package.test.ts fails when the build no longer rounds to it.
 */
export const CLI_BUNDLE_KB = 22;

/** Allowed check intervals, in seconds (mirrored by a CHECK constraint on endpoints). */
export const ENDPOINT_INTERVALS = [60, 300, 900] as const;
export type EndpointInterval = (typeof ENDPOINT_INTERVALS)[number];

export const ENDPOINT_METHODS = ['GET', 'HEAD'] as const;
export type EndpointMethod = (typeof ENDPOINT_METHODS)[number];

/** Consecutive failed checks that open an alert (only after the endpoint has had an ok check). */
export const ALERT_FAILURE_THRESHOLD = 2;

/** An alert links the most recent deploy within this window before the first failed check. */
export const DEPLOY_LINK_WINDOW_MINUTES = 30;

/** One uptime check's whole budget (connect, TLS, redirects, headers), and its redirect limit. */
export const CHECK_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 5;

/** Checks older than this are deleted nightly. */
export const CHECK_RETENTION_DAYS = 30;

/** pg-boss queue for GitHub App pull request checks: web enqueues from the webhook, the worker runs it. */
export const PR_CHECK_QUEUE = 'pr-check';

/** A queued pull request check. The worker reads the pull request's current head when it runs. */
export interface PrCheckJobData {
  /** GitHub's installation id (not ours). */
  installationId: number;
  repoFullName: string;
  prNumber: number;
}

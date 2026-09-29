/**
 * Hard caps, enforced server-side for every account whatever its plan. They bound what one user,
 * or one bug, can make deployhealth store, fetch, or aim checks at.
 */

/** Monitored endpoints in one project. */
export const MAX_ENDPOINTS_PER_PROJECT = 100;
/** Monitored endpoints across all of one user's projects. */
export const MAX_ENDPOINTS_PER_USER = 500;

/** No target hostname is checked more than once per this many milliseconds, across all users. */
export const HOST_CHECK_SPACING_MS = 10_000;

/** POST /api/ingest/scan request body. */
export const MAX_INGEST_BODY_BYTES = 5 * 1024 * 1024;

/** A pull request check fetches at most this many files from GitHub (base and head together)... */
export const MAX_PR_CHECK_FILES = 2_000;
/** ...and at most this many bytes of file content. */
export const MAX_PR_CHECK_BYTES = 20 * 1024 * 1024;

export type LimitName = 'endpointsPerProject' | 'endpointsPerUser' | 'prCheckFiles' | 'prCheckBytes';

/** A hard cap was reached. `message` is safe to show to the user. */
export class LimitExceededError extends Error {
  constructor(
    readonly limit: LimitName,
    message: string,
  ) {
    super(message);
    this.name = 'LimitExceededError';
  }
}

/**
 * Counts what a pull request check downloads. Call `take(size)` for each file before fetching it
 * (sizes come from the git tree, so a whole check can be refused before the first download), and
 * `verify(declared, actual)` after, so a file larger than its tree entry can't slip past the cap.
 */
export function createFetchBudget({ maxFiles = MAX_PR_CHECK_FILES, maxBytes = MAX_PR_CHECK_BYTES } = {}) {
  let files = 0;
  let bytes = 0;
  const overBytes = () =>
    new LimitExceededError('prCheckBytes', `This pull request needs more than ${maxBytes / 1024 / 1024} MB of files; too large to check.`);
  return {
    take(size: number): void {
      if (!Number.isFinite(size) || size < 0) throw new TypeError(`invalid file size: ${size}`);
      if (files + 1 > maxFiles) {
        throw new LimitExceededError('prCheckFiles', `This pull request needs more than ${maxFiles} files; too large to check.`);
      }
      if (bytes + size > maxBytes) throw overBytes();
      files += 1;
      bytes += size;
    },
    verify(declared: number, actual: number): void {
      bytes += actual - declared;
      if (bytes > maxBytes) throw overBytes();
    },
    get used() {
      return { files, bytes };
    },
  };
}

// How long backups and the records that outlive deleted accounts are kept, in one place: the
// backup job (Phase 9b) keeps the last BACKUP_RETENTION_WEEKS weekly dumps, and the nightly prune
// keeps account_deletions rows past the oldest of them, so a restore can always re-apply every
// deletion newer than its dump. /privacy states both from here (web lib/legal.ts).

/** Weekly backups kept: a deleted account leaves every backup within about this many weeks. */
export const BACKUP_RETENTION_WEEKS = 4;

/** Days an account_deletions row (GitHub id and time) is kept: the backups' span plus a week. */
export const ACCOUNT_DELETION_RECORD_DAYS = (BACKUP_RETENTION_WEEKS + 1) * 7;

/**
 * The backup service runs every day and takes a dump only when the newest one in the bucket is
 * older than this, so there's one a week, and a failed run is retried by the next day's.
 */
export const BACKUP_DUMP_INTERVAL_DAYS = 6.5;

/** The worker's operator alert fires when the backup service hasn't succeeded for this long. */
export const BACKUP_STALE_DAYS = 8;

// How long backups and the records that outlive deleted accounts are kept, in one place: the
// backup job (Phase 9b) keeps the last BACKUP_RETENTION_WEEKS weekly dumps, and the nightly prune
// keeps account_deletions rows past the oldest of them, so a restore can always re-apply every
// deletion newer than its dump. /privacy states both from here (web lib/legal.ts).

/** Weekly backups kept: a deleted account leaves every backup within about this many weeks. */
export const BACKUP_RETENTION_WEEKS = 4;

/** Days an account_deletions row (GitHub id and time) is kept: the backups' span plus a week. */
export const ACCOUNT_DELETION_RECORD_DAYS = (BACKUP_RETENTION_WEEKS + 1) * 7;

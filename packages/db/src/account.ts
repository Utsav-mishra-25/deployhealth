import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { deleteUser, planUserDeletion, type UserDeletion } from './delete-user';
import { users } from './schema';

// Self-serve deletion for the account page: the signed-in user's own id only (the login and
// GitHub id selectors stay with the operator's delete-user). Same deleteUser() as the operator's,
// so exactly the same rows go, and the same refusals hold (the demo and dev users).

export { ACCOUNT_DELETION_RECORD_DAYS, DELETION_TABLE_LABELS, DELETION_TABLES, pruneAccountDeletions, UserDeletionError } from './delete-user';
export type { DeletionCounts, DeletionTable, UserDeletion } from './delete-user';

/** What deleting the signed-in user's account would remove, per table; changes nothing. */
export function planOwnAccountDeletion(db: Db, userId: string): Promise<UserDeletion> {
  return planUserDeletion(db, { userId });
}

/** Delete the signed-in user's account and everything it owns, in one transaction. */
export function deleteOwnAccount(db: Db, userId: string): Promise<UserDeletion> {
  return deleteUser(db, { userId });
}

/**
 * Whether the signed-in user's row still exists. Sessions are JWTs, so a session can outlive its
 * account (deleted from another browser, or by the operator); requireUser() signs it out then.
 */
export async function userExists(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  return row !== undefined;
}

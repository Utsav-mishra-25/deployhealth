'use server';

import { deleteOwnAccount, UserDeletionError } from '@deployhealth/db';
import { redirect } from 'next/navigation';
import { signOut } from '@/auth';
import { confirmationMatches, DELETED_PATH } from '@/lib/account';
import { getDb } from '@/lib/db';
import { requireWritableUser } from '@/lib/guard';

/**
 * "Delete my account": the typed confirmation must be the account's GitHub login. Deletes the
 * account and everything it owns in one transaction (the operator's delete-user, by the signed-in
 * user's id; its deletion is recorded), then signs this browser out onto the deleted page.
 */
export async function deleteMyAccount(formData: FormData): Promise<void> {
  const user = await requireWritableUser();
  if (!confirmationMatches(formData.get('confirm'), user.login)) redirect('/account?delete=mismatch#delete-account');
  try {
    await deleteOwnAccount(getDb(), user.id);
  } catch (error) {
    if (error instanceof UserDeletionError) redirect('/account?delete=refused#delete-account');
    throw error;
  }
  await signOut({ redirectTo: DELETED_PATH });
}

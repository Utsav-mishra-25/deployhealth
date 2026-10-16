import { userExists } from '@deployhealth/db';
import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';
import { DELETED_PATH } from '@/lib/account';
import { getDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Where requireUser() sends a session whose account no longer exists: signs it out and shows the
 * deleted page. A session whose account exists is never signed out here (so a link to this route
 * can't sign anyone out); it goes back to /clients. No session: /login.
 */
export async function GET(): Promise<never> {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  if (await userExists(getDb(), session.user.id)) redirect('/clients');
  return signOut({ redirectTo: DELETED_PATH }) as Promise<never>;
}

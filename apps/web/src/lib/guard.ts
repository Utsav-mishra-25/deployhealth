import { isDemoUser } from '@deployhealth/db';
import { requireUser } from '@/auth';
import { getDb } from '@/lib/db';

/** Thrown by requireWritableUser() for the public demo user. */
export class ReadOnlyDemoError extends Error {
  constructor() {
    super('The demo is read-only. Sign in to make changes to your own projects.');
    this.name = 'ReadOnlyDemoError';
  }
}

/**
 * The signed-in user, allowed to write. Every server action calls this first, before reading its
 * arguments or touching the database, so the public demo user can never change anything,
 * whichever route or form the request came from (test/guard.test.ts calls every exported action).
 */
export async function requireWritableUser(): ReturnType<typeof requireUser> {
  const user = await requireUser();
  if (await isDemoUser(getDb(), user.id)) throw new ReadOnlyDemoError();
  return user;
}

import { getDemoUser, type User } from '@deployhealth/db';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { serverEnv } from '@/env';
import { getDb } from '@/lib/db';

/** True when the read-only public demo (/demo, /api/demo/broken) is switched on. */
export function isDemoPublic(): boolean {
  return serverEnv().DEMO_PUBLIC === '1';
}

/** The demo user when the demo is on and seeded, else null. For route handlers. */
export async function findDemoOwner(): Promise<User | null> {
  if (!isDemoPublic()) return null;
  return getDemoUser(getDb());
}

/**
 * The demo user whose data /demo shows, without a session. 404s when DEMO_PUBLIC isn't '1' or
 * the demo hasn't been seeded yet. Cached per request, so every demo page can call it.
 */
export const demoOwner = cache(async (): Promise<User> => {
  const user = await findDemoOwner();
  if (!user) notFound();
  return user;
});

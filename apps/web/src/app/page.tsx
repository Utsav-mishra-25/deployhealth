import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { Landing } from '@/components/landing';
import { isDemoPublic } from '@/lib/demo';
import { LANDING_PAGE_METADATA } from '@/lib/landing';

export const metadata = LANDING_PAGE_METADATA;

/** Signed in: your clients. Signed out: the landing page (indexable). */
export default async function Home() {
  if (await auth()) redirect('/clients');
  return <Landing demo={isDemoPublic()} />;
}

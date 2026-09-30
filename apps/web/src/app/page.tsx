import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { Landing } from '@/components/landing';
import { isDemoPublic } from '@/lib/demo';

/** Signed in: your clients. Signed out: the landing page (indexable). */
export default async function Home() {
  if (await auth()) redirect('/clients');
  return <Landing demo={isDemoPublic()} />;
}

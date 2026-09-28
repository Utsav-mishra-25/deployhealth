import { requireUser } from '@/auth';

/** Everything under /clients requires a signed-in user. */
export default async function ClientsLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return children;
}

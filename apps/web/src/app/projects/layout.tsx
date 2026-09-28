import { requireUser } from '@/auth';

/** Everything under /projects requires a signed-in user. */
export default async function ProjectsLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return children;
}

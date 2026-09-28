import { redirect } from 'next/navigation';

/** Projects are listed under their clients now. */
export default function ProjectsPage() {
  redirect('/clients');
}

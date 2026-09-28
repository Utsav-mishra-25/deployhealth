import Link from 'next/link';
import { NewProjectForm } from './new-project-form';

export default function NewProjectPage() {
  return (
    <div>
      <Link href="/projects" className="text-sm text-gray-500 hover:text-gray-900">
        ← Projects
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">New project</h1>
      <p className="mt-1 mb-6 text-sm text-gray-600">
        One project per repository. You&apos;ll get a token for its GitHub Action.
      </p>
      <NewProjectForm />
    </div>
  );
}

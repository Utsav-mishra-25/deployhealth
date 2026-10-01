import { listClients } from '@deployhealth/db';
import { requireUser } from '@/auth';
import { Breadcrumb } from '@/components/breadcrumb';
import { getDb } from '@/lib/db';
import { projectPrefill } from '@/lib/github-app';
import { NewProjectForm } from './new-project-form';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ client?: string; repo?: string }> }) {
  const user = await requireUser();
  const { client: clientSlug, repo } = await searchParams;
  // ?repo=owner/repo (from the GitHub App's next steps) pre-fills the form; anything else is ignored.
  const prefill = projectPrefill(repo);
  const clients = await listClients(getDb(), user.id);
  const preselected = clients.find((c) => c.slug === clientSlug)?.id ?? '';

  return (
    <div>
      <Breadcrumb items={[{ label: 'Clients', href: '/clients' }, { label: 'New project' }]} />
      <h1 className="mt-2 text-2xl font-semibold">New project</h1>
      <p className="mt-1 mb-6 text-sm text-gray-600">
        One project per repository. You&apos;ll get a token for its GitHub Action.
      </p>
      <NewProjectForm
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        defaultClientId={preselected}
        defaultName={prefill?.name ?? ''}
        defaultRepoFullName={prefill?.repoFullName ?? ''}
      />
    </div>
  );
}

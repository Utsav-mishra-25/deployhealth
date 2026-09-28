import { getClientBySlug, listClientsOverview } from '@deployhealth/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { Breadcrumb } from '@/components/breadcrumb';
import { ConfirmButton } from '@/components/confirm-button';
import { ProjectRows, ProjectTableHead } from '@/components/project-rows';
import { getDb } from '@/lib/db';
import { deleteClientAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function ClientPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const db = getDb();
  const client = await getClientBySlug(db, user.id, slug);
  if (!client) notFound();
  const projects = (await listClientsOverview(db, user.id)).clients.find((c) => c.id === client.id)?.projects ?? [];

  return (
    <div className="space-y-8">
      <Breadcrumb items={[{ label: 'Clients', href: '/clients' }, { label: client.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{client.name}</h1>
          {client.contactEmail && (
            <a href={`mailto:${client.contactEmail}`} className="text-sm text-gray-600 hover:text-gray-900">
              {client.contactEmail}
            </a>
          )}
        </div>
        <div className="flex gap-2">
          <Link href={`/clients/${client.slug}/edit`} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
            Edit
          </Link>
          <form action={deleteClientAction.bind(null, client.id)}>
            <ConfirmButton
              message={`Delete ${client.name}? Its ${projects.length} project(s) stay, unassigned.`}
              className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
            >
              Delete client
            </ConfirmButton>
          </form>
        </div>
      </div>

      {client.notes && (
        <section aria-labelledby="notes">
          <h2 id="notes" className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Notes
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm text-gray-700">{client.notes}</p>
        </section>
      )}

      <section aria-labelledby="client-projects">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="client-projects" className="text-lg font-semibold">
            Projects
          </h2>
          <Link href={`/projects/new?client=${client.slug}`} className="text-sm font-medium text-emerald-700 hover:underline">
            Add project
          </Link>
        </div>
        {projects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">No projects for this client yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <ProjectTableHead />
              <tbody className="divide-y divide-gray-100">
                <ProjectRows projects={projects} />
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

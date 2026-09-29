import { monthOf } from '@deployhealth/core';
import { agentPrStats, getClientBySlug, listClientsOverview } from '@deployhealth/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { deleteClientAction } from '@/app/clients/actions';
import { Breadcrumb } from '@/components/breadcrumb';
import { ConfirmButton } from '@/components/confirm-button';
import { ProjectRows, ProjectTableHead } from '@/components/project-rows';
import { getDb } from '@/lib/db';
import type { ViewPaths } from '@/lib/paths';

/** One client: contact, notes and projects. Rendered at /clients/:slug and /demo/clients/:slug. */
export async function ClientView({ ownerId, slug, paths, readOnly }: { ownerId: string; slug: string; paths: ViewPaths; readOnly: boolean }) {
  const db = getDb();
  const client = await getClientBySlug(db, ownerId, slug);
  if (!client) notFound();
  const month = monthOf(new Date());
  const [overview, agentPrs] = await Promise.all([listClientsOverview(db, ownerId), agentPrStats(db, ownerId, client.id, month.from, month.to)]);
  const projects = overview.clients.find((c) => c.id === client.id)?.projects ?? [];

  return (
    <div className="space-y-8">
      <Breadcrumb items={[{ label: 'Clients', href: paths.clients }, { label: client.name }]} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{client.name}</h1>
          {client.contactEmail && (
            <a href={`mailto:${client.contactEmail}`} className="text-sm text-gray-600 hover:text-gray-900">
              {client.contactEmail}
            </a>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={paths.clientReport(client.slug)} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
            Monthly report
          </Link>
          {!readOnly && (
            <Link href={`/clients/${client.slug}/edit`} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
              Edit
            </Link>
          )}
          {!readOnly && (
            <form action={deleteClientAction.bind(null, client.id)}>
              <ConfirmButton
                message={`Delete ${client.name}? Its ${projects.length} project(s) stay, unassigned.`}
                className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
              >
                Delete client
              </ConfirmButton>
            </form>
          )}
        </div>
      </div>

      <p className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-700" data-testid="agent-pr-stat">
        Agent PRs that added undeclared env vars this month:{' '}
        <strong className={agentPrs.undeclared > 0 ? 'text-red-700' : 'text-gray-900'}>
          {agentPrs.undeclared} of {agentPrs.total}
        </strong>
        <span className="text-gray-500"> · pull requests by coding agents (Claude, Codex, Copilot, Cursor, Devin), checked by the GitHub App</span>
      </p>

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
          {!readOnly && (
            <Link href={`/projects/new?client=${client.slug}`} className="text-sm font-medium text-emerald-700 hover:underline">
              Add project
            </Link>
          )}
        </div>
        {projects.length === 0 ? (
          <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-500">No projects for this client yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <ProjectTableHead />
              <tbody className="divide-y divide-gray-100">
                <ProjectRows projects={projects} paths={paths} />
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

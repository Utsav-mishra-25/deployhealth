import { listClientsOverview } from '@deployhealth/db';
import type { AppCovers } from '@/lib/project-status';
import Link from 'next/link';
import { ProjectRows, ProjectTableHead, StatusSummary } from '@/components/project-rows';
import { getDb } from '@/lib/db';
import type { ViewPaths } from '@/lib/paths';
import { rankProjects, statusSummary, worstStatusRank } from '@/lib/project-status';

/**
 * Every client with its projects, plus "No client", worst first: projects by status then name, and
 * clients by their worst project then name ("No client" stays last). Rendered at /clients and /demo.
 */
export async function ClientsOverviewView({
  ownerId,
  paths,
  readOnly,
  appCovers,
}: {
  ownerId: string;
  paths: ViewPaths;
  readOnly: boolean;
  /** Signed in: whether the user's own App installations cover a repository ("Not set up"'s reason). */
  appCovers?: AppCovers;
}) {
  const overview = await listClientsOverview(getDb(), ownerId);
  const now = new Date();
  const clients = overview.clients
    .map((c) => ({ ...c, projects: rankProjects(c.projects, now, appCovers) }))
    .map((c) => ({ ...c, rank: worstStatusRank(c.projects.map((p) => p.status)) }))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const unassigned = rankProjects(overview.unassigned, now, appCovers);
  const summary = statusSummary([...clients.flatMap((c) => c.projects), ...unassigned].map((p) => p.status));
  const empty = clients.length === 0 && unassigned.length === 0;
  // Clients are optional and offered only after the first project: until then there's no "New
  // client" button, and with no clients the list is just "Projects" (no "No client" group).
  const hasClients = clients.length > 0;

  return (
    <div id="projects" className="scroll-mt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{hasClients ? 'Clients' : 'Projects'}</h1>
        {!readOnly && (
          <div className="flex gap-2">
            {hasClients && (
              <Link href="/clients/new" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
                New client
              </Link>
            )}
            <Link href="/projects/new" className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800">
              New project
            </Link>
          </div>
        )}
      </div>

      <div className="mt-2">
        <StatusSummary text={summary} />
      </div>

      {!readOnly && !empty && !hasClients && (
        <p className="mt-2 text-sm text-gray-600" data-testid="client-offer">
          Working for several clients?{' '}
          <Link href="/clients/new" className="font-medium text-emerald-700 hover:underline">
            Group projects by client
          </Link>{' '}
          (optional).
        </p>
      )}

      {empty ? (
        <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center" data-testid="projects-empty">
          <p className="font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-gray-600">Each project is one GitHub repository. Its status shows up here once it&apos;s set up.</p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm max-sm:block">
            <ProjectTableHead />
            {clients.map((client) => (
              <tbody key={client.id} className="divide-y divide-gray-100 border-t border-gray-200 first-of-type:max-sm:border-t-0 max-sm:block">
                <tr className="bg-gray-50/60 max-sm:block">
                  <th colSpan={3} scope="rowgroup" className="py-2 pr-4 pl-4 text-left max-sm:block">
                    <Link href={paths.client(client.slug)} className="font-semibold text-gray-900 hover:text-emerald-700">
                      {client.name}
                    </Link>
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      {client.projects.length} {client.projects.length === 1 ? 'project' : 'projects'}
                      {client.contactEmail ? ` · ${client.contactEmail}` : ''}
                    </span>
                  </th>
                </tr>
                {client.projects.length === 0 ? (
                  <tr className="max-sm:block">
                    <td colSpan={3} className="py-3 pl-8 text-sm text-gray-500 max-sm:block max-sm:pl-4">
                      No projects yet
                    </td>
                  </tr>
                ) : (
                  <ProjectRows projects={client.projects} indent paths={paths} />
                )}
              </tbody>
            ))}
            {unassigned.length > 0 && (
              <tbody id="no-client" className="divide-y divide-gray-100 border-t border-gray-200 first-of-type:max-sm:border-t-0 max-sm:block">
                {hasClients && (
                  <tr className="bg-gray-50/60 max-sm:block">
                    <th colSpan={3} scope="rowgroup" className="py-2 pr-4 pl-4 text-left font-semibold text-gray-500 max-sm:block">
                      No client
                    </th>
                  </tr>
                )}
                <ProjectRows projects={unassigned} indent={hasClients} paths={paths} />
              </tbody>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

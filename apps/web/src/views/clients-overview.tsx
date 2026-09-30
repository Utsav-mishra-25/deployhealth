import { listClientsOverview } from '@deployhealth/db';
import Link from 'next/link';
import { ProjectRows, ProjectTableHead } from '@/components/project-rows';
import { getDb } from '@/lib/db';
import type { ViewPaths } from '@/lib/paths';

/** Every client with its projects, plus "No client". Rendered at /clients and /demo. */
export async function ClientsOverviewView({ ownerId, paths, readOnly }: { ownerId: string; paths: ViewPaths; readOnly: boolean }) {
  const { clients, unassigned } = await listClientsOverview(getDb(), ownerId);
  const empty = clients.length === 0 && unassigned.length === 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Clients</h1>
        {!readOnly && (
          <div className="flex gap-2">
            <Link href="/clients/new" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50">
              New client
            </Link>
            <Link href="/projects/new" className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500">
              New project
            </Link>
          </div>
        )}
      </div>

      {empty ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="font-medium">Nothing here yet</p>
          <p className="mt-1 text-sm text-gray-600">Add a client, then the projects you maintain for them.</p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm max-sm:block">
            <ProjectTableHead />
            {clients.map((client) => (
              <tbody key={client.id} className="divide-y divide-gray-100 border-t border-gray-200 first-of-type:max-sm:border-t-0 max-sm:block">
                <tr className="bg-gray-50/60 max-sm:block">
                  <th colSpan={4} scope="rowgroup" className="py-2 pr-4 pl-4 text-left max-sm:block">
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
                    <td colSpan={4} className="py-3 pl-8 text-sm text-gray-400 max-sm:block max-sm:pl-4">
                      No projects yet
                    </td>
                  </tr>
                ) : (
                  <ProjectRows projects={client.projects} indent paths={paths} />
                )}
              </tbody>
            ))}
            {unassigned.length > 0 && (
              <tbody id="no-client" className="divide-y divide-gray-100 border-t border-gray-200 max-sm:block">
                <tr className="bg-gray-50/60 max-sm:block">
                  <th colSpan={4} scope="rowgroup" className="py-2 pr-4 pl-4 text-left font-semibold text-gray-500 max-sm:block">
                    No client
                  </th>
                </tr>
                <ProjectRows projects={unassigned} indent paths={paths} />
              </tbody>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

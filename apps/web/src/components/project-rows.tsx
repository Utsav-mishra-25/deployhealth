import type { ProjectListItem } from '@deployhealth/db';
import Link from 'next/link';
import { shortSha } from '@/lib/format';
import { APP_PATHS, type ViewPaths } from '@/lib/paths';
import { CountPills } from './counts';
import { FailingFor, UptimeBadge } from './status-badge';
import { TimeAgo } from './time-ago';

/**
 * Table rows for projects: env findings, last deploy and uptime. Used on /clients and client pages.
 * Below 640 px each row becomes a card (CSS grid on the same cells, so nothing is rendered twice):
 * the name with the uptime status beside it, then the findings and the last deploy.
 */
export function ProjectRows({
  projects,
  indent = false,
  paths = APP_PATHS,
}: {
  projects: ProjectListItem[];
  indent?: boolean;
  paths?: ViewPaths;
}) {
  return (
    <>
      {projects.map((p) => (
        <tr
          key={p.id}
          className="hover:bg-gray-50 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:gap-x-3 max-sm:gap-y-2 max-sm:px-4 max-sm:py-3"
          data-testid="project-row"
        >
          <td className={`py-3 pr-3 ${indent ? 'pl-8' : 'pl-4'} max-sm:col-start-1 max-sm:row-start-1 max-sm:min-w-0 max-sm:p-0`}>
            <Link href={paths.project(p.id)} className="font-medium break-words text-gray-900 hover:text-emerald-700">
              {p.name}
            </Link>
            <div className="text-xs break-all text-gray-500">{p.repoFullName}</div>
          </td>
          <td className="px-3 py-3 max-sm:col-span-2 max-sm:p-0">
            {p.counts ? <CountPills counts={p.counts} /> : <span className="text-sm text-gray-500">No scans yet</span>}
            {p.openPrsWithUndeclared > 0 && (
              <Link href={`${paths.project(p.id)}#pull-requests`} className="mt-1 block text-xs font-medium text-red-700 hover:underline" data-testid="open-prs-undeclared">
                {p.openPrsWithUndeclared} open PR{p.openPrsWithUndeclared === 1 ? '' : 's'} with undeclared env vars
              </Link>
            )}
          </td>
          <td className="px-3 py-3 text-sm text-gray-600 max-sm:col-span-2 max-sm:p-0">
            {p.lastDeploy ? (
              <>
                <span className="sm:hidden">Last deploy </span>
                <code className="font-mono">{shortSha(p.lastDeploy.sha)}</code> · <TimeAgo date={p.lastDeploy.deployedAt} />
              </>
            ) : (
              <span className="text-gray-500">—</span>
            )}
          </td>
          <td className="py-3 pr-4 pl-3 max-sm:col-start-2 max-sm:row-start-1 max-sm:max-w-44 max-sm:p-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 max-sm:justify-end max-sm:text-right">
              <UptimeBadge status={p.uptime} />
              {p.failingSince && (
                <FailingFor state={p.uptime === 'down' ? 'down' : 'failing'} since={p.failingSince} subject={failingSubject(p.failingEndpoints)} />
              )}
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

/** "Acme API", or "Acme API +1 more" when several endpoints are behind the badge. */
function failingSubject(labels: string[]): string | undefined {
  if (labels.length === 0) return undefined;
  return labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1} more`;
}

export function ProjectTableHead() {
  return (
    <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 max-sm:hidden">
      <tr>
        <th className="py-2 pr-3 pl-4 font-medium">Project</th>
        <th className="px-3 py-2 font-medium">Env findings</th>
        <th className="px-3 py-2 font-medium">Last deploy</th>
        <th className="py-2 pr-4 pl-3 font-medium">Uptime</th>
      </tr>
    </thead>
  );
}

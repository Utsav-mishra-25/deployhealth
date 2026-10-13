import type { ProjectListItem } from '@deployhealth/db';
import Link from 'next/link';
import { shortSha } from '@/lib/format';
import { APP_PATHS, type ViewPaths } from '@/lib/paths';
import type { ProjectStatusView } from '@/lib/project-status';
import { ProjectStatusBadge } from './status-badge';
import { TimeAgo } from './time-ago';

export type RankedProject = ProjectListItem & ProjectStatusView;

/**
 * Table rows for projects, already ranked (`rankProjects`): the status as a text label with its
 * reasons, non-zero findings only, then the last deploy. Used on /clients, client pages and /demo.
 * Below 640 px each row becomes a card (CSS grid on the same cells, so nothing is rendered twice).
 */
export function ProjectRows({
  projects,
  indent = false,
  paths = APP_PATHS,
}: {
  projects: RankedProject[];
  indent?: boolean;
  paths?: ViewPaths;
}) {
  return (
    <>
      {projects.map((p) => (
        <tr key={p.id} className="hover:bg-gray-50 max-sm:grid max-sm:grid-cols-1 max-sm:gap-y-2 max-sm:px-4 max-sm:py-3" data-testid="project-row" data-status={p.status}>
          <td className={`py-3 pr-3 ${indent ? 'pl-8' : 'pl-4'} sm:min-w-44 max-sm:min-w-0 max-sm:p-0`}>
            <Link href={paths.project(p.id)} className="font-medium break-words text-gray-900 hover:text-emerald-700">
              {p.name}
            </Link>
            <div className="text-xs break-all text-gray-500">{p.repoFullName}</div>
          </td>
          <td className="px-3 py-3 max-sm:p-0">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <ProjectStatusBadge status={p.status} />
              <span className="text-xs break-words text-gray-700" data-testid="status-reasons">
                {p.reasons.map((reason, i) => (
                  <span key={reason.text}>
                    {i > 0 && ' · '}
                    {reason.anchor ? (
                      <Link href={`${paths.project(p.id)}#${reason.anchor}`} className="underline decoration-gray-300 underline-offset-2 hover:text-gray-900 hover:decoration-gray-500">
                        {reason.text}
                      </Link>
                    ) : (
                      reason.text
                    )}
                  </span>
                ))}
                {p.status === 'healthy' && p.checkedAt && (
                  <span className="text-gray-500">
                    {p.reasons.length > 0 && ' · '}checked <TimeAgo date={p.checkedAt} />
                  </span>
                )}
              </span>
            </div>
          </td>
          <td className="py-3 pr-4 pl-3 text-sm text-gray-600 sm:whitespace-nowrap max-sm:p-0">
            {p.lastDeploy ? (
              <>
                <span className="sm:hidden">Last deploy </span>
                <code className="font-mono">{shortSha(p.lastDeploy.sha)}</code> · <TimeAgo date={p.lastDeploy.deployedAt} />
              </>
            ) : (
              <span className="text-gray-500">
                <span className="sm:hidden">Last deploy </span>—
              </span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

export function ProjectTableHead() {
  return (
    <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500 max-sm:hidden">
      <tr>
        <th className="py-2 pr-3 pl-4 font-medium">Project</th>
        <th className="px-3 py-2 font-medium">Status</th>
        <th className="py-2 pr-4 pl-3 font-medium">Last deploy</th>
      </tr>
    </thead>
  );
}

/** "2 of 5 projects need attention · 1 down" above a project list (nothing for an empty list). */
export function StatusSummary({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="text-sm font-medium text-gray-700" data-testid="status-summary">
      {text}
    </p>
  );
}

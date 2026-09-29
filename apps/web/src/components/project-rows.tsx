import type { ProjectListItem } from '@deployhealth/db';
import Link from 'next/link';
import { shortSha } from '@/lib/format';
import { CountPills } from './counts';
import { FailingFor, UptimeBadge } from './status-badge';
import { TimeAgo } from './time-ago';

/** Table rows for projects: env findings, last deploy and uptime. Used on /clients and client pages. */
export function ProjectRows({ projects, indent = false }: { projects: ProjectListItem[]; indent?: boolean }) {
  return (
    <>
      {projects.map((p) => (
        <tr key={p.id} className="hover:bg-gray-50" data-testid="project-row">
          <td className={`py-3 pr-3 ${indent ? 'pl-8' : 'pl-4'}`}>
            <Link href={`/projects/${p.id}`} className="font-medium text-gray-900 hover:text-emerald-700">
              {p.name}
            </Link>
            <div className="text-xs text-gray-500">{p.repoFullName}</div>
          </td>
          <td className="px-3 py-3">{p.counts ? <CountPills counts={p.counts} /> : <span className="text-sm text-gray-400">No scans yet</span>}</td>
          <td className="px-3 py-3 text-sm text-gray-600">
            {p.lastDeploy ? (
              <>
                <code className="font-mono">{shortSha(p.lastDeploy.sha)}</code> · <TimeAgo date={p.lastDeploy.deployedAt} />
              </>
            ) : (
              <span className="text-gray-400">—</span>
            )}
          </td>
          <td className="py-3 pr-4 pl-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <UptimeBadge status={p.uptime} />
              {p.failingSince && <FailingFor state={p.uptime === 'down' ? 'down' : 'failing'} since={p.failingSince} />}
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

export function ProjectTableHead() {
  return (
    <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
      <tr>
        <th className="py-2 pr-3 pl-4 font-medium">Project</th>
        <th className="px-3 py-2 font-medium">Env findings</th>
        <th className="px-3 py-2 font-medium">Last deploy</th>
        <th className="py-2 pr-4 pl-3 font-medium">Uptime</th>
      </tr>
    </thead>
  );
}

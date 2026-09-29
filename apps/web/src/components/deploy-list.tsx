import type { DeployListItem } from '@deployhealth/db';
import Link from 'next/link';
import { shortSha } from '@/lib/format';
import { CountPills } from './counts';
import { TimeAgo } from './time-ago';

export function DeployList({
  projectPath,
  deploys,
  selectedId,
}: {
  /** The project page the deploy links point at (/projects/:id or /demo/projects/:id). */
  projectPath: string;
  deploys: DeployListItem[];
  selectedId: string | undefined;
}) {
  return (
    <table className="w-full overflow-hidden rounded-lg bg-white text-left text-sm ring-1 ring-gray-200">
      <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
        <tr>
          <th className="px-3 py-2 font-medium">Commit</th>
          <th className="px-3 py-2 font-medium">Branch</th>
          <th className="px-3 py-2 font-medium">Deployed</th>
          <th className="px-3 py-2 font-medium">Source</th>
          <th className="px-3 py-2 font-medium">Latest scan</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {deploys.map(({ deploy, counts, scanCount }) => {
          const selected = deploy.id === selectedId;
          return (
            <tr key={deploy.id} className={selected ? 'bg-emerald-50' : 'hover:bg-gray-50'} aria-current={selected || undefined}>
              <td className="px-3 py-2">
                <Link href={`${projectPath}?deploy=${deploy.id}`} className="font-mono text-emerald-700 hover:underline">
                  {shortSha(deploy.sha)}
                </Link>
              </td>
              <td className="px-3 py-2 text-gray-700">{deploy.branch}</td>
              <td className="px-3 py-2 text-gray-600">
                <TimeAgo date={deploy.deployedAt} />
              </td>
              <td className="px-3 py-2 text-gray-500">{deploy.source}</td>
              <td className="px-3 py-2">
                {counts ? <CountPills counts={counts} /> : <span className="text-gray-400">—</span>}
                {scanCount > 1 && <span className="ml-2 text-xs text-gray-400">({scanCount} scans)</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

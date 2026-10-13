import type { DeployHistoryItem } from '@deployhealth/db';
import Link from 'next/link';
import { changeLine, commitUrl, outageLine } from '@/lib/deploy-changes';
import { shortSha } from '@/lib/format';
import { TimeAgo } from './time-ago';

/**
 * The project's deploys, newest first: what each changed compared with the previous scanned deploy,
 * and the outage that started after it (before the next deploy), in plain text. The latest scan's
 * counts are in the cards at the top of the page, not repeated per row.
 */
export function DeployList({
  projectPath,
  repoFullName,
  deploys,
  selectedId,
  readOnly,
}: {
  /** The project page the scan links point at (/projects/:id or /demo/projects/:id). */
  projectPath: string;
  repoFullName: string;
  deploys: DeployHistoryItem[];
  selectedId: string | undefined;
  /** The demo: its repositories are made up, so commits aren't linked to GitHub. */
  readOnly: boolean;
}) {
  return (
    <div className="relative overflow-x-auto rounded-lg bg-white ring-1 ring-gray-200">
      <table className="w-full text-left text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2 font-medium">Commit</th>
            <th className="px-3 py-2 font-medium">Branch</th>
            <th className="px-3 py-2 font-medium">Deployed</th>
            <th className="px-3 py-2 font-medium">What changed</th>
            <th className="px-3 py-2 font-medium">
              <span className="sr-only">Scan</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {deploys.map(({ deploy, change, outage, scanCount }) => {
            const selected = deploy.id === selectedId;
            const url = commitUrl(repoFullName, deploy.sha, readOnly);
            return (
              <tr
                key={deploy.id}
                className={`align-top ${selected ? 'bg-emerald-50' : 'hover:bg-gray-50'}`}
                aria-current={selected || undefined}
                data-testid="deploy-row"
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  {url ? (
                    <a href={url} className="font-mono text-emerald-700 hover:underline" target="_blank" rel="noopener noreferrer" data-testid="commit-link">
                      {shortSha(deploy.sha)}
                    </a>
                  ) : (
                    <code className="font-mono text-gray-700">{shortSha(deploy.sha)}</code>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{deploy.branch}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                  <TimeAgo date={deploy.deployedAt} />
                </td>
                <td className="min-w-64 px-3 py-2 break-words">
                  <span className={change.kind === 'diff' && change.introduced.length === 0 && change.fixed.length === 0 ? 'text-gray-500' : 'text-gray-900'} data-testid="deploy-change">
                    {changeLine(change)}
                  </span>
                  {scanCount > 1 && <span className="ml-2 text-xs text-gray-500">({scanCount} scans)</span>}
                  {outage && (
                    <p className="mt-1 text-xs font-medium text-red-700" data-testid="deploy-outage">
                      {outageLine(outage, deploy.deployedAt)}
                    </p>
                  )}
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {change.kind === 'unscanned' ? null : selected ? (
                    <span className="text-xs text-gray-500">Showing</span>
                  ) : (
                    <Link href={`${projectPath}?deploy=${deploy.id}`} className="text-xs font-medium text-emerald-700 hover:underline">
                      View scan<span className="sr-only"> of {shortSha(deploy.sha)}</span>
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

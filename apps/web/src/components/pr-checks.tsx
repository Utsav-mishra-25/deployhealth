import type { PrCheckListItem } from '@deployhealth/db';
import { shortSha } from '@/lib/format';
import { TimeAgo } from './time-ago';

const RESULT = {
  success: ['bg-emerald-50 text-emerald-700 ring-emerald-200', 'Passed'],
  neutral: ['bg-amber-50 text-amber-800 ring-amber-200', 'Flagged'],
  failure: ['bg-red-50 text-red-700 ring-red-200', 'Failed'],
} as const;

/** "Claude", "Copilot", …: the pull request came from a coding agent. */
export function AgentBadge({ name }: { name: string }) {
  return (
    <span data-testid="agent-badge" className="rounded bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-200">
      {name}
    </span>
  );
}

/**
 * Recent pull requests the GitHub App checked (the latest check of each): number, author,
 * result and undeclared env vars. Links go to GitHub.
 */
export function PrChecksSection({ repoFullName, checks, readOnly }: { repoFullName: string; checks: PrCheckListItem[]; readOnly: boolean }) {
  return (
    <section aria-labelledby="pull-requests-heading" id="pull-requests">
      <h2 id="pull-requests-heading" className="mb-3 text-lg font-semibold">
        Pull requests
      </h2>
      {checks.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-sm text-gray-600">
          No pull requests checked yet.{' '}
          {!readOnly && 'Install the GitHub App from Settings to check env vars on every pull request.'}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="py-2 pr-3 pl-4 font-medium">Pull request</th>
                <th className="px-3 py-2 font-medium">Author</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Undeclared</th>
                <th className="py-2 pr-4 pl-3 font-medium">Checked</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {checks.map((c) => {
                const [tone, label] = RESULT[c.conclusion];
                return (
                  <tr key={c.prNumber} data-testid="pr-check-row">
                    <td className="py-2 pr-3 pl-4">
                      <a href={`https://github.com/${repoFullName}/pull/${c.prNumber}`} className="font-medium text-gray-900 hover:text-emerald-700">
                        #{c.prNumber}
                      </a>
                      <span className="ml-2 font-mono text-xs text-gray-500">{shortSha(c.headSha)}</span>
                      {c.closed && <span className="ml-2 text-xs text-gray-500">closed</span>}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        {c.authorLogin}
                        {c.authorIsAgent && <AgentBadge name={c.agentName ?? 'Agent'} />}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>{label}</span>
                      {c.secretHits > 0 && <span className="ml-2 text-xs text-red-700">{c.secretHits} possible secret{c.secretHits === 1 ? '' : 's'}</span>}
                    </td>
                    <td className="px-3 py-2 tabular-nums" data-testid="pr-undeclared">
                      {c.undeclared > 0 ? <span className="font-medium text-red-700">{c.undeclared}</span> : <span className="text-gray-400">0</span>}
                    </td>
                    <td className="py-2 pr-4 pl-3 text-gray-600">
                      <TimeAgo date={c.checkedAt} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

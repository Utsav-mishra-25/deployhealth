import { listProjectsForOwner } from '@deployhealth/db';
import Link from 'next/link';
import { requireUser } from '@/auth';
import { CountPills } from '@/components/counts';
import { TimeAgo } from '@/components/time-ago';
import { getDb } from '@/lib/db';
import { shortSha } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const user = await requireUser();
  const projects = await listProjectsForOwner(getDb(), user.id);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Projects</h1>
        <Link
          href="/projects/new"
          className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500"
        >
          New project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="mt-8 rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-gray-600">Create one to get an ingest token and a GitHub Action to paste.</p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 hover:bg-gray-50"
              >
                <div>
                  <div className="font-medium">{p.name}</div>
                  <div className="text-sm text-gray-500">{p.repoFullName}</div>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
                  {p.lastDeploy ? (
                    <span>
                      <code className="font-mono">{shortSha(p.lastDeploy.sha)}</code> on {p.lastDeploy.branch} ·{' '}
                      <TimeAgo date={p.lastDeploy.deployedAt} />
                    </span>
                  ) : (
                    <span className="text-gray-400">No scans yet</span>
                  )}
                  {p.counts && <CountPills counts={p.counts} />}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

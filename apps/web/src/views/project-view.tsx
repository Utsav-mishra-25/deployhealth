import { getClientForOwner, getLatestScan, getProjectForOwner, getProjectMonitoring, listDeploys, listOpenAlerts } from '@deployhealth/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertsBanner } from '@/components/alerts-banner';
import { Breadcrumb } from '@/components/breadcrumb';
import { SummaryCards } from '@/components/counts';
import { DeployList } from '@/components/deploy-list';
import { EndpointsSection } from '@/components/endpoints-section';
import { FindingsByKind } from '@/components/findings-table';
import { TimeAgo } from '@/components/time-ago';
import { getDb } from '@/lib/db';
import { isUuid, shortSha } from '@/lib/format';
import type { ViewPaths } from '@/lib/paths';

/**
 * A project: open alerts, latest (or selected) scan, endpoints, findings and deploys. Rendered at
 * /projects/:id and, read-only, at /demo/projects/:id.
 */
export async function ProjectView({
  ownerId,
  projectId,
  requestedDeploy,
  paths,
  readOnly,
}: {
  ownerId: string;
  projectId: string;
  requestedDeploy: string | undefined;
  paths: ViewPaths;
  readOnly: boolean;
}) {
  if (!isUuid(projectId)) notFound();
  const db = getDb();
  const project = await getProjectForOwner(db, projectId, ownerId);
  if (!project) notFound();

  const [client, deploys, openAlerts, monitoring] = await Promise.all([
    project.clientId ? getClientForOwner(db, ownerId, project.clientId) : null,
    listDeploys(db, project.id),
    listOpenAlerts(db, ownerId, project.id),
    getProjectMonitoring(db, ownerId, project.id),
  ]);
  const latestId = deploys[0]?.deploy.id;
  const selectedId = isUuid(requestedDeploy) ? requestedDeploy : latestId;
  const detail = selectedId ? await getLatestScan(db, project.id, selectedId) : null;
  const isLatest = detail?.deploy.id === latestId;
  const projectPath = paths.project(project.id);

  return (
    <div className="space-y-10">
      <div className="space-y-4">
        <Breadcrumb
          items={[
            { label: 'Clients', href: paths.clients },
            client ? { label: client.name, href: paths.client(client.slug) } : { label: 'No client', href: `${paths.clients}#no-client` },
            { label: project.name },
          ]}
        />
        <AlertsBanner projectPath={projectPath} alerts={openAlerts} />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">{project.name}</h1>
            <a
              href={`https://github.com/${project.repoFullName}`}
              className="text-sm text-gray-500 hover:text-gray-900"
              target="_blank"
              rel="noopener noreferrer"
            >
              {project.repoFullName}
            </a>
          </div>
          {!readOnly && (
            <Link
              href={`/projects/${project.id}/settings`}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50"
            >
              Settings &amp; GitHub Action
            </Link>
          )}
        </div>
      </div>

      {detail ? (
        <section aria-labelledby="summary">
          <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 id="summary" className="text-lg font-semibold">
              {isLatest ? 'Latest scan' : 'Scan'}
            </h2>
            <span className="text-sm text-gray-500">
              <code className="font-mono">{shortSha(detail.deploy.sha)}</code> on {detail.deploy.branch} · deployed{' '}
              <TimeAgo date={detail.deploy.deployedAt} /> · scanned <TimeAgo date={detail.scan.createdAt} />
            </span>
            {!isLatest && (
              <Link href={projectPath} className="text-sm text-emerald-700 hover:underline">
                Back to latest
              </Link>
            )}
          </div>
          <SummaryCards
            counts={{ missing: detail.scan.missingCount, unused: detail.scan.unusedCount, mismatch: detail.scan.mismatchCount }}
          />
        </section>
      ) : (
        <div className="rounded-lg border border-dashed border-gray-300 bg-white p-10 text-center">
          <p className="font-medium">No scans yet</p>
          {!readOnly && (
            <p className="mt-1 text-sm text-gray-600">
              Add the GitHub Action from{' '}
              <Link href={`/projects/${project.id}/settings`} className="text-emerald-700 hover:underline">
                Settings
              </Link>{' '}
              and push to see the first scan here.
            </p>
          )}
        </div>
      )}

      <EndpointsSection projectId={project.id} endpoints={monitoring} readOnly={readOnly} />

      {detail && (
        <>
          <section aria-labelledby="findings">
            <h2 id="findings" className="mb-3 text-lg font-semibold">
              Findings
            </h2>
            <FindingsByKind findings={detail.findings} />
          </section>

          <section aria-labelledby="deploys">
            <h2 id="deploys" className="mb-3 text-lg font-semibold">
              Deploys
            </h2>
            <DeployList projectPath={projectPath} deploys={deploys} selectedId={detail.deploy.id} />
          </section>
        </>
      )}
    </div>
  );
}

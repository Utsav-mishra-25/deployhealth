import type { OpenAlertView } from '@deployhealth/db';
import Link from 'next/link';
import { shortSha } from '@/lib/format';
import { TimeAgo } from './time-ago';

/** Open alerts, shown at the top of the project page. */
export function AlertsBanner({ projectId, alerts }: { projectId: string; alerts: OpenAlertView[] }) {
  if (alerts.length === 0) return null;
  return (
    <section aria-label="Open alerts" className="space-y-2">
      {alerts.map(({ alert, deploy }) => (
        <div key={alert.id} role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-medium text-red-800">{alert.message}</p>
            <span className="text-xs text-red-700">
              open since <TimeAgo date={alert.createdAt} />
            </span>
          </div>
          {deploy && (
            <Link href={`/projects/${projectId}?deploy=${deploy.id}`} className="mt-1 inline-block text-sm text-red-700 underline">
              View deploy {shortSha(deploy.sha)} and its findings
            </Link>
          )}
        </div>
      ))}
    </section>
  );
}

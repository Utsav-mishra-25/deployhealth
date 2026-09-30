import type { OpenAlertView } from '@deployhealth/db';
import { shortSha } from '@/lib/format';
import { AlertCard } from './alert-card';
import { TimeAgo } from './time-ago';

/** Open alerts, shown at the top of the project page. */
export function AlertsBanner({ projectPath, alerts }: { projectPath: string; alerts: OpenAlertView[] }) {
  if (alerts.length === 0) return null;
  return (
    <section aria-label="Open alerts" className="space-y-2">
      {alerts.map(({ alert, deploy }) => (
        <AlertCard
          key={alert.id}
          message={alert.message}
          aside={
            <>
              open since <TimeAgo date={alert.createdAt} />
            </>
          }
          link={deploy ? { href: `${projectPath}?deploy=${deploy.id}`, label: `View deploy ${shortSha(deploy.sha)} and its findings` } : undefined}
        />
      ))}
    </section>
  );
}

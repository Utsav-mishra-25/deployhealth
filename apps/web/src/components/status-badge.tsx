import { failingFor } from '@deployhealth/core/browser';
import type { EndpointStatus } from '@deployhealth/db';
import { STATUS_LABELS, type ProjectStatus } from '@/lib/project-status';

const TONES = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  gray: 'bg-gray-50 text-gray-500 ring-gray-200',
} as const;

function Badge({ tone, label, testId }: { tone: keyof typeof TONES; label: string; testId?: string }) {
  return (
    <span data-testid={testId} className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${tone === 'gray' ? 'bg-gray-400' : 'bg-current'}`} />
      {label}
    </span>
  );
}

const PROJECT_TONES: Record<ProjectStatus, keyof typeof TONES> = {
  down: 'red',
  attention: 'amber',
  not_set_up: 'gray',
  healthy: 'green',
};

/** A project's status on the project lists: always a text label, the colour only repeats it. */
export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_TONES[status]} label={STATUS_LABELS[status]} testId="project-status" />;
}

const ENDPOINT: Record<EndpointStatus, [keyof typeof TONES, string]> = {
  up: ['green', 'Up'],
  failing: ['amber', 'Failing'],
  down: ['red', 'Down'],
  paused: ['gray', 'Paused'],
  pending: ['gray', 'No checks yet'],
};

export function EndpointStatusBadge({ status }: { status: EndpointStatus }) {
  const [tone, label] = ENDPOINT[status];
  return <Badge tone={tone} label={label} testId="endpoint-status" />;
}

/**
 * "Down for 21m" (or "Failing for 1m" before an alert opens), shown next to a badge while the
 * latest check is failing. `since` is the first failed check of the current run.
 */
export function FailingFor({ state, since, subject }: { state: 'down' | 'failing'; since: Date; subject?: string }) {
  return (
    <time
      dateTime={since.toISOString()}
      title={`First failed check: ${since.toUTCString()}`}
      data-testid="failing-for"
      className={`text-xs font-medium ${state === 'down' ? 'text-red-700' : 'text-amber-800'}`}
    >
      {failingFor(state, since, new Date(), subject)}
    </time>
  );
}

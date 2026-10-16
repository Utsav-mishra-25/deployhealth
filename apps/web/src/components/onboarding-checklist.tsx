import Link from 'next/link';
import { newProjectHref } from '@/lib/github-app';
import { CHECKLIST_TITLE, type Checklist, type ChecklistStep } from '@/lib/onboarding';

/** "Done" or "To do" as text; the colour only repeats it. */
function StepState({ done, optional }: { done: boolean; optional: boolean }) {
  const [tone, label] = done
    ? ['bg-emerald-50 text-emerald-700 ring-emerald-200', 'Done']
    : optional
      ? ['bg-gray-50 text-gray-500 ring-gray-200', 'Optional']
      : ['bg-amber-50 text-amber-800 ring-amber-200', 'To do'];
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>{label}</span>;
}

function StepAction({ step }: { step: ChecklistStep }) {
  if (!step.action) return step.blocked ? <p className="mt-1 text-sm text-gray-500">{step.blocked}</p> : null;
  const { href, label, external } = step.action;
  const className = step.done
    ? 'text-sm font-medium text-emerald-700 hover:underline'
    : 'inline-block rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800';
  return (
    <p className="mt-2">
      {external ? (
        <a href={href} className={className}>
          {label}
        </a>
      ) : (
        <Link href={href} className={className}>
          {label}
        </Link>
      )}
    </p>
  );
}

/** Step 2: the repositories the App can already see, one click each (pre-filled). */
const SUGGESTED = 3;

function Suggestions({ repos }: { repos: readonly string[] }) {
  const shown = repos.slice(0, SUGGESTED);
  return (
    <div className="mt-2 text-sm text-gray-700" data-testid="checklist-suggestions">
      <p>The App can see {repos.length === 1 ? 'this repository' : 'these repositories'}:</p>
      <ul className="mt-1 space-y-1">
        {shown.map((repo) => (
          <li key={repo}>
            <Link href={newProjectHref(repo)} className="font-medium text-emerald-700 hover:underline">
              Add a project for <span className="font-mono break-all">{repo}</span>
            </Link>
          </li>
        ))}
        <li>
          <Link href="/projects/new" className="font-medium text-emerald-700 hover:underline">
            Another repository
          </Link>
        </li>
      </ul>
      {repos.length > shown.length && (
        <p className="mt-1">
          And {repos.length - shown.length} more on the{' '}
          <Link href="/github/installed" className="font-medium text-emerald-700 hover:underline">
            GitHub App page
          </Link>
          .
        </p>
      )}
    </div>
  );
}

function StepBody({ step, n, suggestedRepos = [] }: { step: ChecklistStep; n?: number; suggestedRepos?: readonly string[] }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium text-gray-900">
          {n !== undefined && <span className="mr-1 text-gray-500">{n}.</span>}
          {step.title}
        </h3>
        <StepState done={step.done} optional={step.optional} />
      </div>
      <p className="mt-1 text-sm text-gray-600">{step.body}</p>
      {step.note && (
        <p className="mt-1 text-sm text-amber-800" data-testid="checklist-uncovered">
          {step.note.text}.{' '}
          <Link href={step.note.href} className="font-medium underline underline-offset-2 hover:text-amber-900">
            {step.note.label}
          </Link>
        </p>
      )}
      {step.id === 'project' && suggestedRepos.length > 0 ? <Suggestions repos={suggestedRepos} /> : <StepAction step={step} />}
    </>
  );
}

/**
 * The first-run checklist on /clients: the landing page's setup order, each step done or not from
 * the user's own data, with a link to the exact place to do it. The optional Action step is a
 * plain <details>, collapsed. Step 2 offers the repositories the App can already see. No JavaScript.
 */
export function OnboardingChecklist({ checklist, suggestedRepos = [] }: { checklist: Checklist; suggestedRepos?: readonly string[] }) {
  if (checklist.complete) return null;
  const required = checklist.steps.filter((s) => !s.optional);
  const optional = checklist.steps.filter((s) => s.optional);
  const done = required.filter((s) => s.done).length;
  return (
    <section aria-labelledby="checklist-title" className="rounded-lg border border-gray-200 bg-white p-4 sm:p-5" data-testid="onboarding-checklist">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="checklist-title" className="text-lg font-semibold">
          {CHECKLIST_TITLE}
        </h2>
        <span className="text-sm text-gray-500">
          {done} of {required.length} done
        </span>
      </div>
      <ol className="mt-3 divide-y divide-gray-100">
        {required.map((step, i) => (
          <li key={step.id} className="py-3 first:pt-0" data-testid={`step-${step.id}`} data-done={step.done}>
            <StepBody step={step} n={i + 1} suggestedRepos={suggestedRepos} />
          </li>
        ))}
      </ol>
      {optional.map((step) => (
        <details key={step.id} className="mt-1 border-t border-gray-100 pt-3" data-testid={`step-${step.id}`} data-done={step.done}>
          <summary className="cursor-pointer text-sm font-medium text-gray-700 hover:text-gray-900">{step.title}</summary>
          <div className="mt-2">
            <StepBody step={step} />
          </div>
        </details>
      ))}
    </section>
  );
}

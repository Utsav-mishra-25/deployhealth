'use client';

import { useActionState, useState } from 'react';
import { RepoCoverageNotice } from '@/components/repo-coverage-notice';
import { REPO_FULL_NAME_PATTERN } from '@/lib/github-app';
import { repoCoverage, type AppCoverage } from '@/lib/repo-coverage';
import { createProjectAction, type CreateProjectState } from '../actions';

const input =
  'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';

/** The repository select's value for "type it instead". */
const OTHER = '';

/** The project name a repository suggests: the part after the slash. */
function nameFor(repo: string): string {
  return repo.slice(repo.indexOf('/') + 1).slice(0, 64);
}

export function NewProjectForm({
  clients,
  showClient,
  defaultClientId,
  defaultName = '',
  defaultRepoFullName = '',
  pickableRepos,
  coverage,
}: {
  clients: Array<{ id: string; name: string }>;
  /** False before the first project: grouping by client is offered later, never first. */
  showClient: boolean;
  defaultClientId: string;
  defaultName?: string;
  defaultRepoFullName?: string;
  /** Repositories the user's App installations cover that have no project yet. */
  pickableRepos: readonly string[];
  /** The user's own installations, to say whether the App covers the repository. */
  coverage: AppCoverage;
}) {
  const [state, action, pending] = useActionState<CreateProjectState, FormData>(createProjectAction, { status: 'idle' });
  const [clientChoice, setClientChoice] = useState(defaultClientId);
  const initialPick = pickableRepos.find((r) => r.toLowerCase() === defaultRepoFullName.toLowerCase()) ?? (defaultRepoFullName ? OTHER : (pickableRepos[0] ?? OTHER));
  const [pick, setPick] = useState(initialPick);
  const [typed, setTyped] = useState(initialPick === OTHER ? defaultRepoFullName : '');
  const [name, setName] = useState(defaultName || (initialPick ? nameFor(initialPick) : ''));
  const [nameEdited, setNameEdited] = useState(Boolean(defaultName));

  const picking = pickableRepos.length > 0;
  const repo = (picking && pick !== OTHER ? pick : typed).trim();
  const chooseRepo = (next: string) => {
    if (!nameEdited && REPO_FULL_NAME_PATTERN.test(next.trim())) setName(nameFor(next.trim()));
  };
  const fields = state.status === 'error' ? state.fields : undefined;
  const noInstallation = coverage.installUrl !== null && coverage.accounts.length === 0;

  return (
    <form action={action} className="max-w-md space-y-4">
      {state.status === 'error' && !fields && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
          {state.message}
        </p>
      )}
      {picking ? (
        <div className="space-y-2">
          <label className="block">
            <span className="text-sm font-medium">GitHub repository</span>
            <select
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                chooseRepo(e.target.value || typed);
              }}
              className={input}
              data-testid="repo-picker"
            >
              {pickableRepos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
              <option value={OTHER}>Another repository…</option>
            </select>
          </label>
          {pick === OTHER && (
            <label className="block">
              <span className="text-sm font-medium">Repository (owner/repo)</span>
              <input
                required
                placeholder="acme/storefront"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  chooseRepo(e.target.value);
                }}
                className={input}
                autoFocus
              />
            </label>
          )}
          <input type="hidden" name="repoFullName" value={repo} />
        </div>
      ) : (
        <label className="block">
          <span className="text-sm font-medium">GitHub repository (owner/repo)</span>
          <input
            name="repoFullName"
            required
            placeholder="acme/storefront"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              chooseRepo(e.target.value);
            }}
            className={input}
          />
        </label>
      )}
      {fields?.repoFullName && <span className="block text-sm text-red-600">{fields.repoFullName}</span>}
      {REPO_FULL_NAME_PATTERN.test(repo) ? (
        <RepoCoverageNotice coverage={repoCoverage(coverage, repo)} repo={repo} />
      ) : (
        noInstallation && (
          <p className="text-sm text-gray-600" data-testid="install-first">
            <a href={coverage.installUrl!} className="font-medium text-emerald-700 hover:underline">
              Install the GitHub App
            </a>{' '}
            first to pick from your repositories, or type one.
          </p>
        )
      )}
      <label className="block">
        <span className="text-sm font-medium">Project name</span>
        <input
          name="name"
          required
          maxLength={64}
          placeholder="storefront"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
          }}
          className={input}
        />
        {fields?.name && <span className="mt-1 block text-sm text-red-600">{fields.name}</span>}
      </label>
      {showClient ? (
        <>
          <label className="block">
            <span className="text-sm font-medium">
              Client <span className="font-normal text-gray-500">(optional)</span>
            </span>
            <select name="clientId" value={clientChoice} onChange={(e) => setClientChoice(e.target.value)} className={input}>
              <option value="">No client</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="__new__">+ New client…</option>
            </select>
            {fields?.clientId && <span className="mt-1 block text-sm text-red-600">{fields.clientId}</span>}
          </label>
          {clientChoice === '__new__' && (
            <label className="block">
              <span className="text-sm font-medium">New client name</span>
              <input name="newClientName" required maxLength={80} placeholder="Acme Corp" className={input} autoFocus />
              {fields?.newClientName && <span className="mt-1 block text-sm text-red-600">{fields.newClientName}</span>}
            </label>
          )}
        </>
      ) : (
        <input type="hidden" name="clientId" value="" />
      )}
      <button
        disabled={pending}
        className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}

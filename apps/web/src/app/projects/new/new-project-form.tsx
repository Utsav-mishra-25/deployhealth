'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { TokenReveal } from '@/components/token-reveal';
import { createProjectAction, type CreateProjectState } from '../actions';

const input =
  'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';

export function NewProjectForm({
  clients,
  defaultClientId,
  defaultName = '',
  defaultRepoFullName = '',
}: {
  clients: Array<{ id: string; name: string }>;
  defaultClientId: string;
  defaultName?: string;
  defaultRepoFullName?: string;
}) {
  const [state, action, pending] = useActionState<CreateProjectState, FormData>(createProjectAction, { status: 'idle' });
  const [clientChoice, setClientChoice] = useState(defaultClientId);

  if (state.status === 'created') {
    return (
      <div className="space-y-6">
        <p className="text-sm text-gray-700">
          Created <strong>{state.projectName}</strong>. Connect it to GitHub:
        </p>
        <TokenReveal token={state.token} snippet={state.snippet} />
        <Link
          href={`/projects/${state.projectId}`}
          className="inline-block rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800"
        >
          Go to project
        </Link>
      </div>
    );
  }

  const fields = state.status === 'error' ? state.fields : undefined;
  return (
    <form action={action} className="max-w-md space-y-4">
      {state.status === 'error' && !fields && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
          {state.message}
        </p>
      )}
      <label className="block">
        <span className="text-sm font-medium">Project name</span>
        <input name="name" required maxLength={64} placeholder="storefront" defaultValue={defaultName} className={input} />
        {fields?.name && <span className="mt-1 block text-sm text-red-600">{fields.name}</span>}
      </label>
      <label className="block">
        <span className="text-sm font-medium">GitHub repository</span>
        <input name="repoFullName" required placeholder="acme/storefront" defaultValue={defaultRepoFullName} className={input} />
        {fields?.repoFullName && <span className="mt-1 block text-sm text-red-600">{fields.repoFullName}</span>}
      </label>
      <label className="block">
        <span className="text-sm font-medium">Client</span>
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
      <button
        disabled={pending}
        className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}

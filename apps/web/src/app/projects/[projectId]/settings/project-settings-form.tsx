'use client';

import { useActionState } from 'react';
import { updateProjectSettingsAction, type SettingsState } from '../../actions';

const input =
  'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';

export function ProjectSettingsForm({
  projectId,
  clients,
  clientId,
  alertWebhookUrl,
  deployNotes,
}: {
  projectId: string;
  clients: Array<{ id: string; name: string }>;
  clientId: string | null;
  alertWebhookUrl: string | null;
  deployNotes: string | null;
}) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(updateProjectSettingsAction.bind(null, projectId), {
    status: 'idle',
  });
  const fields = state.status === 'error' ? state.fields : undefined;

  return (
    <form action={action} className="max-w-xl space-y-4">
      <label className="block">
        <span className="text-sm font-medium">Client</span>
        <select name="clientId" defaultValue={clientId ?? ''} className={input}>
          <option value="">No client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        {fields?.clientId && <span className="mt-1 block text-sm text-red-600">{fields.clientId}</span>}
      </label>
      <label className="block">
        <span className="text-sm font-medium">Alert webhook URL</span> <span className="text-sm text-gray-500">(optional)</span>
        <input
          name="alertWebhookUrl"
          type="url"
          defaultValue={alertWebhookUrl ?? ''}
          placeholder="https://hooks.slack.com/services/…"
          className={input}
        />
        <span className="mt-1 block text-xs text-gray-500">
          Receives <code>{'{"text": "…"}'}</code> when an alert opens or resolves. Slack incoming webhooks work as-is; for
          Discord, append <code>/slack</code> to the webhook URL.
        </span>
        {fields?.alertWebhookUrl && <span className="mt-1 block text-sm text-red-600">{fields.alertWebhookUrl}</span>}
      </label>
      <label className="block">
        <span className="text-sm font-medium">How to deploy</span> <span className="text-sm text-gray-500">(optional, Markdown)</span>
        <textarea
          name="deployNotes"
          rows={8}
          maxLength={20_000}
          defaultValue={deployNotes ?? ''}
          placeholder={'## Railway\n\n1. Push to `main`; Railway builds and deploys it.\n2. Migrations run in the pre-deploy step.'}
          className={`${input} font-mono`}
        />
        <span className="mt-1 block text-xs text-gray-500">
          The &ldquo;How to deploy&rdquo; section of the handoff export. Raw HTML and images aren&rsquo;t rendered.
        </span>
        {fields?.deployNotes && <span className="mt-1 block text-sm text-red-600">{fields.deployNotes}</span>}
      </label>
      {state.status === 'error' && !fields && <p className="text-sm text-red-600">{state.message}</p>}
      <div className="flex items-center gap-3">
        <button
          disabled={pending}
          className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Save settings'}
        </button>
        {state.status === 'saved' && <span className="text-sm text-emerald-700">Saved</span>}
      </div>
    </form>
  );
}

'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import type { ClientFormState, ClientFormValues } from './actions';

const input =
  'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';

export function ClientForm({
  action,
  initial,
  submitLabel,
  cancelHref,
}: {
  action: (prev: ClientFormState, form: FormData) => Promise<ClientFormState>;
  initial: ClientFormValues;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });
  const values = state.status === 'error' ? state.values : initial;
  const fields = state.status === 'error' ? state.fields : {};

  return (
    <form action={formAction} className="max-w-md space-y-4">
      {state.status === 'error' && Object.keys(fields).length === 0 && (
        <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-700">
          {state.message}
        </p>
      )}
      <label className="block">
        <span className="text-sm font-medium">Client name</span>
        <input name="name" required maxLength={80} defaultValue={values.name} placeholder="Acme Corp" className={input} />
        {fields.name && <span className="mt-1 block text-sm text-red-600">{fields.name}</span>}
      </label>
      <label className="block">
        <span className="text-sm font-medium">Contact email</span> <span className="text-sm text-gray-500">(optional)</span>
        <input name="contactEmail" type="email" defaultValue={values.contactEmail} placeholder="ops@acme.example" className={input} />
        {fields.contactEmail && <span className="mt-1 block text-sm text-red-600">{fields.contactEmail}</span>}
      </label>
      <label className="block">
        <span className="text-sm font-medium">Notes</span> <span className="text-sm text-gray-500">(optional)</span>
        <textarea name="notes" rows={4} maxLength={2000} defaultValue={values.notes} placeholder="Retainer, hosting, who to call…" className={input} />
        {fields.notes && <span className="mt-1 block text-sm text-red-600">{fields.notes}</span>}
      </label>
      <div className="flex items-center gap-3">
        <button
          disabled={pending}
          className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link href={cancelHref} className="text-sm text-gray-500 hover:text-gray-900">
          Cancel
        </Link>
      </div>
    </form>
  );
}

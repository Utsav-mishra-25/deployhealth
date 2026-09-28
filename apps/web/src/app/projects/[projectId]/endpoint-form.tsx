'use client';

import { ENDPOINT_INTERVALS, ENDPOINT_METHODS } from '@deployhealth/core/browser';
import { useActionState, useEffect, useRef } from 'react';
import type { EndpointFormState, EndpointFormValues } from './endpoint-actions';

const input =
  'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500';

const INTERVAL_LABELS: Record<number, string> = { 60: 'Every minute', 300: 'Every 5 minutes', 900: 'Every 15 minutes' };

export function EndpointForm({
  action,
  initial,
  submitLabel,
  resetOnSave = false,
}: {
  action: (prev: EndpointFormState, form: FormData) => Promise<EndpointFormState>;
  initial: EndpointFormValues;
  submitLabel: string;
  resetOnSave?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { status: 'idle' });
  const formRef = useRef<HTMLFormElement>(null);
  const values = state.status === 'error' ? state.values : initial;
  const fields = state.status === 'error' ? state.fields : {};

  useEffect(() => {
    if (state.status === 'saved' && resetOnSave) formRef.current?.reset();
  }, [state, resetOnSave]);

  return (
    <form ref={formRef} action={formAction} className="grid gap-3 sm:grid-cols-6">
      <label className="block sm:col-span-6">
        <span className="text-sm font-medium">URL</span>
        <input name="url" type="url" required defaultValue={values.url} placeholder="https://api.example.com/health" className={input} />
        {fields.url && <span className="mt-1 block text-sm text-red-600">{fields.url}</span>}
      </label>
      <label className="block sm:col-span-1">
        <span className="text-sm font-medium">Method</span>
        <select name="method" defaultValue={values.method || 'GET'} className={input}>
          {ENDPOINT_METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className="text-sm font-medium">Interval</span>
        <select name="intervalSeconds" defaultValue={String(values.intervalSeconds || 300)} className={input}>
          {ENDPOINT_INTERVALS.map((s) => (
            <option key={s} value={s}>
              {INTERVAL_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className="text-sm font-medium">Expected status</span>
        <input name="expectedStatus" type="number" min={100} max={599} required defaultValue={values.expectedStatus || '200'} className={input} />
        {fields.expectedStatus && <span className="mt-1 block text-sm text-red-600">{fields.expectedStatus}</span>}
      </label>
      <label className="flex items-center gap-2 self-end pb-2 sm:col-span-1">
        <input name="enabled" type="checkbox" defaultChecked={values.enabled} className="h-4 w-4 rounded border-gray-300" />
        <span className="text-sm">Enabled</span>
      </label>
      <div className="flex items-center gap-3 sm:col-span-6">
        <button
          disabled={pending}
          className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        {state.status === 'saved' && <span className="text-sm text-emerald-700">Saved</span>}
        {state.status === 'error' && Object.keys(fields).length === 0 && <span className="text-sm text-red-600">{state.message}</span>}
      </div>
    </form>
  );
}

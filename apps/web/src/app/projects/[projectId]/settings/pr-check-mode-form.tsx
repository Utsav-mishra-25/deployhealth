'use client';

import type { PrCheckMode } from '@deployhealth/db';
import { useActionState } from 'react';
import { updatePrCheckModeAction, type PrCheckModeState } from '../../actions';

const MODES: Array<{ value: PrCheckMode; label: string; help: string }> = [
  { value: 'comment', label: 'Comment', help: 'Comment on the pull request; the check is neutral when something is flagged.' },
  { value: 'strict', label: 'Strict', help: 'Also fail the check, so branch protection can block the merge.' },
  { value: 'off', label: 'Off', help: 'Do nothing on this repository’s pull requests.' },
];

export function PrCheckModeForm({ projectId, mode }: { projectId: string; mode: PrCheckMode }) {
  const [state, action, pending] = useActionState<PrCheckModeState, FormData>(updatePrCheckModeAction.bind(null, projectId), { status: 'idle' });
  return (
    <form action={action} className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">On each pull request</legend>
        {MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-2 text-sm">
            <input type="radio" name="mode" value={m.value} defaultChecked={m.value === mode} className="mt-1" />
            <span>
              <span className="font-medium">{m.label}</span> <span className="text-gray-600">· {m.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50">
          Save mode
        </button>
        {state.status === 'saved' && <span className="text-sm text-emerald-700">Saved</span>}
        {state.status === 'error' && <span className="text-sm text-red-600">{state.message}</span>}
      </div>
    </form>
  );
}

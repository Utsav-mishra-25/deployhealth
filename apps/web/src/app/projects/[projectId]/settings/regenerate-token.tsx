'use client';

import { useActionState } from 'react';
import { TokenReveal } from '@/components/token-reveal';
import { regenerateTokenAction, type RegenerateState } from '../../actions';

/**
 * Creates the Action's token (`first`: no deploy has been reported yet, so no workflow is using
 * one) or replaces it. Either way the plaintext is shown once, here.
 */
export function RegenerateToken({ projectId, repo, first }: { projectId: string; repo: string; first: boolean }) {
  const [state, action, pending] = useActionState<RegenerateState>(regenerateTokenAction.bind(null, projectId), { status: 'idle' });

  if (state.status === 'created') {
    return (
      <div className="mt-4">
        {!first && (
          <p className="mb-4 text-sm text-gray-700">
            The old token stopped working. Update the <code>DEPLOYHEALTH_TOKEN</code> secret in GitHub:
          </p>
        )}
        <TokenReveal token={state.token} workflow={state.workflow} snippet={state.snippet} repo={repo} />
      </div>
    );
  }

  const confirmText = first
    ? 'Create a token? Any token made earlier for this project stops working.'
    : 'Regenerate the token? The current one stops working immediately.';
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(confirmText)) e.preventDefault();
      }}
      className="mt-3"
    >
      {state.status === 'error' && <p className="mb-2 text-sm text-red-600">{state.message}</p>}
      <button
        disabled={pending}
        className={
          first
            ? 'rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50'
            : 'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50'
        }
      >
        {pending ? 'Creating…' : first ? 'Create token' : 'Regenerate token'}
      </button>
    </form>
  );
}

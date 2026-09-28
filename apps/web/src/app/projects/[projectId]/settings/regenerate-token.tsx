'use client';

import { useActionState } from 'react';
import { TokenReveal } from '@/components/token-reveal';
import { regenerateTokenAction, type RegenerateState } from '../../actions';

export function RegenerateToken({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<RegenerateState>(
    regenerateTokenAction.bind(null, projectId),
    { status: 'idle' },
  );

  if (state.status === 'created') {
    return (
      <div className="mt-4">
        <p className="mb-4 text-sm text-gray-700">
          The old token stopped working. Update the <code>DEPLOYHEALTH_TOKEN</code> secret in GitHub:
        </p>
        <TokenReveal token={state.token} snippet={state.snippet} />
      </div>
    );
  }

  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm('Regenerate the token? The current one stops working immediately.')) e.preventDefault();
      }}
      className="mt-3"
    >
      {state.status === 'error' && <p className="mb-2 text-sm text-red-600">{state.message}</p>}
      <button
        disabled={pending}
        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
      >
        {pending ? 'Regenerating…' : 'Regenerate token'}
      </button>
    </form>
  );
}

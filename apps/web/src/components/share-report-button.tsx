'use client';

import { useState, useTransition } from 'react';
import { createReportShareLinkAction, type ShareLinkState } from '@/app/clients/report-actions';

/** "Share report": creates a signed 90-day link and shows it with a copy button. */
export function ShareReportButton({ clientId, month }: { clientId: string; month: string }) {
  const [state, setState] = useState<ShareLinkState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  if (state.status === 'created') {
    return (
      <div className="flex w-full flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm" data-testid="share-link">
        <input readOnly value={state.url} aria-label="Share link" className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="rounded-md border border-gray-300 bg-white px-2 py-1 font-medium hover:bg-gray-50"
          onClick={async () => {
            await navigator.clipboard?.writeText(state.url).catch(() => {});
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <span className="text-xs text-emerald-900">Anyone with the link can view this report until {state.expiresAt.slice(0, 10)}.</span>
      </div>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(async () => setState(await createReportShareLinkAction(clientId, month)))}
        className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
      >
        {pending ? 'Creating link…' : 'Share report'}
      </button>
      {state.status === 'error' && <span className="text-sm text-red-600">{state.message}</span>}
    </span>
  );
}

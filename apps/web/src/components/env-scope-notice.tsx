import { plural } from '@deployhealth/core/browser';
import Link from 'next/link';

/**
 * One notice per scope with no env file at all, instead of a MISSING row per reference: nothing
 * declares those variables yet, so they aren't "missing" from anything. The handoff offers them as
 * a starting .env.example.
 */
export function NoEnvFileNotices({ scopes, handoffHref }: { scopes: Array<{ scope: string; variables: number }>; handoffHref: string }) {
  if (scopes.length === 0) return null;
  return (
    <div className="space-y-2">
      {scopes.map((s) => (
        <div key={s.scope} role="note" data-testid="no-env-file-notice" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-900">
            No .env.example here: {plural(s.variables, 'variable')} referenced
          </p>
          <p className="mt-1 text-amber-900">
            {s.scope === '' ? (
              'The repository root has no env file'
            ) : (
              <>
                <code className="font-mono break-all">{s.scope}</code> has no env file
              </>
            )}
            , so its variables aren&apos;t listed as missing.{' '}
            <Link href={`${handoffHref}#variables`} className="font-medium underline">
              Copy them as a starting .env.example
            </Link>{' '}
            from the handoff.
          </p>
        </div>
      ))}
    </div>
  );
}

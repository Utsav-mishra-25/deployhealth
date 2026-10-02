import { DEPLOY_HISTORY_OPTION, PR_CHECKS_OPTION } from '@/lib/setup-copy';
import { SecretSteps } from './secret-steps';

/** The two ways to set up a project, side by side. Short copy, no wizard, never a token value. */
export function SetupOptions({ repo }: { repo?: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="setup-options">
      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
        <h3 className="font-semibold text-gray-900">{PR_CHECKS_OPTION.title}</h3>
        <p className="mt-1">{PR_CHECKS_OPTION.body}</p>
      </div>
      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700">
        <h3 className="font-semibold text-gray-900">{DEPLOY_HISTORY_OPTION.title}</h3>
        <p className="mt-1">{DEPLOY_HISTORY_OPTION.body}</p>
        <SecretSteps repo={repo} />
      </div>
    </div>
  );
}

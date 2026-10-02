import { DEPLOY_HISTORY_OPTION, PR_CHECKS_OPTION } from '@/lib/setup-copy';
import { CodeBlock } from './code-block';
import { CopyButton } from './copy-button';
import { SecretSteps } from './secret-steps';

/** Shown exactly once after a token is created or regenerated. */
export function TokenReveal({ token, snippet }: { token: string; snippet: string }) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
        <div className="text-sm font-medium text-amber-900">Copy your ingest token now. It won&apos;t be shown again.</div>
        <div className="mt-3 flex items-center gap-2">
          <code data-testid="new-token" className="flex-1 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-sm ring-1 ring-amber-200">
            {token}
          </code>
          <CopyButton text={token} />
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-700" data-testid="pr-checks-option">
        <h3 className="font-semibold text-gray-900">{PR_CHECKS_OPTION.title}</h3>
        <p className="mt-1">{PR_CHECKS_OPTION.body} Install it from this project&apos;s settings.</p>
      </div>

      <div className="text-sm text-gray-700" data-testid="deploy-history-option">
        <h3 className="font-semibold text-gray-900">{DEPLOY_HISTORY_OPTION.title}</h3>
        <ol className="mt-2 list-decimal space-y-4 pl-5">
          <li>
            Save the token above as a repository secret:
            <SecretSteps />
          </li>
          <li>
            Add this workflow. It scans the repo on every push to <code>main</code> and reports here:
            <div className="mt-2">
              <CodeBlock code={snippet} label=".github/workflows/deployhealth.yml" />
            </div>
          </li>
          <li>Push. The deploy shows up on the project page within seconds.</li>
        </ol>
      </div>
    </div>
  );
}

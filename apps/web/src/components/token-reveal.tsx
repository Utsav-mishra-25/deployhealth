import { TOKEN_ONCE } from '@/lib/setup-copy';
import { CodeBlock } from './code-block';
import { CopyButton } from './copy-button';
import { SecretSteps } from './secret-steps';

/** Shown exactly once, in settings, after the Action's token is created or replaced. */
export function TokenReveal({ token, snippet, repo }: { token: string; snippet: string; repo?: string }) {
  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
        <div className="text-sm font-medium text-amber-900">{TOKEN_ONCE}</div>
        <div className="mt-3 flex items-center gap-2">
          <code data-testid="new-token" className="flex-1 overflow-x-auto rounded bg-white px-3 py-2 font-mono text-sm ring-1 ring-amber-200">
            {token}
          </code>
          <CopyButton text={token} />
        </div>
      </div>

      <ol className="list-decimal space-y-4 pl-5 text-sm text-gray-700" data-testid="deploy-history-steps">
        <li>
          Save the token above as a repository secret:
          <SecretSteps repo={repo} />
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
  );
}

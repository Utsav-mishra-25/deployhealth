import { githubActionSnippet, TOKEN_SECRET_NAME } from '@deployhealth/core';
import { getProjectForOwner } from '@deployhealth/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { CodeBlock } from '@/components/code-block';
import { appUrl } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';
import { RegenerateToken } from './regenerate-token';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireUser();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const project = await getProjectForOwner(getDb(), projectId, user.id);
  if (!project) notFound();

  const url = await appUrl();
  const snippet = githubActionSnippet({ appUrl: url });
  const localRun = `curl -fsSL ${url}/deployhealth-scan.mjs -o deployhealth-scan.mjs
node deployhealth-scan.mjs --dry-run`;

  return (
    <div className="max-w-3xl space-y-10">
      <div>
        <Link href={`/projects/${project.id}`} className="text-sm text-gray-500 hover:text-gray-900">
          ← {project.name}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">Settings</h1>
      </div>

      <section>
        <h2 className="text-lg font-semibold">Ingest token</h2>
        <p className="mt-1 text-sm text-gray-600">
          Current token: <code className="font-mono">{project.apiTokenHint}</code>. Tokens are stored hashed, so a lost
          token can only be replaced.
        </p>
        <RegenerateToken projectId={project.id} />
      </section>

      <section>
        <h2 className="text-lg font-semibold">GitHub Action</h2>
        <p className="mt-1 mb-3 text-sm text-gray-600">
          Save the token as the repository secret <code className="font-mono font-semibold">{TOKEN_SECRET_NAME}</code>,
          then add this workflow to <strong>{project.repoFullName}</strong>:
        </p>
        <CodeBlock code={snippet} label=".github/workflows/deployhealth.yml" />
      </section>

      <section>
        <h2 className="text-lg font-semibold">Try it locally</h2>
        <p className="mt-1 mb-3 text-sm text-gray-600">
          Prints what the Action would report, without sending anything. Add <code>--ignore</code> or{' '}
          <code>--exclude</code> to narrow it down.
        </p>
        <CodeBlock code={localRun} label="shell" />
      </section>
    </div>
  );
}

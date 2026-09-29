import { githubActionSnippet, TOKEN_SECRET_NAME } from '@deployhealth/core';
import { getClientForOwner, getProjectForOwner, listClients } from '@deployhealth/db';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { Breadcrumb } from '@/components/breadcrumb';
import { CodeBlock } from '@/components/code-block';
import { appUrl } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';
import { ProjectSettingsForm } from './project-settings-form';
import { RegenerateToken } from './regenerate-token';

export const dynamic = 'force-dynamic';

export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const user = await requireUser();
  const { projectId } = await params;
  if (!isUuid(projectId)) notFound();
  const db = getDb();
  const project = await getProjectForOwner(db, projectId, user.id);
  if (!project) notFound();
  const [client, clients] = await Promise.all([
    project.clientId ? getClientForOwner(db, user.id, project.clientId) : null,
    listClients(db, user.id),
  ]);

  const url = await appUrl();
  const snippet = githubActionSnippet({ appUrl: url });
  const localRun = `curl -fsSL ${url}/deployhealth-scan.mjs -o deployhealth-scan.mjs
node deployhealth-scan.mjs --dry-run`;

  return (
    <div className="max-w-3xl space-y-10">
      <div>
        <Breadcrumb
          items={[
            { label: 'Clients', href: '/clients' },
            client ? { label: client.name, href: `/clients/${client.slug}` } : { label: 'No client', href: '/clients#no-client' },
            { label: project.name, href: `/projects/${project.id}` },
            { label: 'Settings' },
          ]}
        />
        <h1 className="mt-2 text-2xl font-semibold">Settings</h1>
      </div>

      <section>
        <h2 className="text-lg font-semibold">Client, alerts &amp; handoff</h2>
        <p className="mt-1 mb-3 text-sm text-gray-600">
          Group this project under a client, choose where alerts are sent, and write down how it deploys.
        </p>
        <ProjectSettingsForm
          projectId={project.id}
          clients={clients.map((c) => ({ id: c.id, name: c.name }))}
          clientId={project.clientId}
          alertWebhookUrl={project.alertWebhookUrl}
          deployNotes={project.deployNotes}
        />
      </section>

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

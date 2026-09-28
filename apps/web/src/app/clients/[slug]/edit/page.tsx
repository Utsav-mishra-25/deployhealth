import { getClientBySlug } from '@deployhealth/db';
import { notFound } from 'next/navigation';
import { requireUser } from '@/auth';
import { Breadcrumb } from '@/components/breadcrumb';
import { getDb } from '@/lib/db';
import { updateClientAction } from '../../actions';
import { ClientForm } from '../../client-form';

export const dynamic = 'force-dynamic';

export default async function EditClientPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireUser();
  const { slug } = await params;
  const client = await getClientBySlug(getDb(), user.id, slug);
  if (!client) notFound();

  return (
    <div className="space-y-6">
      <Breadcrumb
        items={[{ label: 'Clients', href: '/clients' }, { label: client.name, href: `/clients/${client.slug}` }, { label: 'Edit' }]}
      />
      <h1 className="text-2xl font-semibold">Edit {client.name}</h1>
      <ClientForm
        action={updateClientAction.bind(null, client.id)}
        initial={{ name: client.name, contactEmail: client.contactEmail ?? '', notes: client.notes ?? '' }}
        submitLabel="Save changes"
        cancelHref={`/clients/${client.slug}`}
      />
    </div>
  );
}

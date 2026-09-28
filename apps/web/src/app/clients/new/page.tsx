import { Breadcrumb } from '@/components/breadcrumb';
import { createClientAction } from '../actions';
import { ClientForm } from '../client-form';

export default function NewClientPage() {
  return (
    <div className="space-y-6">
      <Breadcrumb items={[{ label: 'Clients', href: '/clients' }, { label: 'New client' }]} />
      <h1 className="text-2xl font-semibold">New client</h1>
      <ClientForm action={createClientAction} initial={{ name: '', contactEmail: '', notes: '' }} submitLabel="Create client" cancelHref="/clients" />
    </div>
  );
}

'use server';

import { createClient, deleteClient, updateClient } from '@deployhealth/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/auth';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';
import { clientFormSchema, fieldErrors, text } from '@/lib/validation';

export interface ClientFormValues {
  name: string;
  contactEmail: string;
  notes: string;
}

export type ClientFormState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fields: Record<string, string>; values: ClientFormValues };

function readForm(form: FormData): ClientFormValues {
  return { name: text(form, 'name'), contactEmail: text(form, 'contactEmail'), notes: text(form, 'notes') };
}

export async function createClientAction(_prev: ClientFormState, form: FormData): Promise<ClientFormState> {
  const user = await requireUser();
  const values = readForm(form);
  const parsed = clientFormSchema.safeParse(values);
  if (!parsed.success) return { status: 'error', message: 'Please fix the highlighted fields.', fields: fieldErrors(parsed.error), values };

  const client = await createClient(getDb(), user.id, parsed.data);
  revalidatePath('/clients');
  redirect(`/clients/${client.slug}`);
}

export async function updateClientAction(clientId: string, _prev: ClientFormState, form: FormData): Promise<ClientFormState> {
  const user = await requireUser();
  const values = readForm(form);
  const parsed = clientFormSchema.safeParse(values);
  if (!parsed.success) return { status: 'error', message: 'Please fix the highlighted fields.', fields: fieldErrors(parsed.error), values };
  if (!isUuid(clientId)) return { status: 'error', message: 'Client not found.', fields: {}, values };

  const client = await updateClient(getDb(), user.id, clientId, parsed.data);
  if (!client) return { status: 'error', message: 'Client not found.', fields: {}, values };
  revalidatePath('/clients');
  redirect(`/clients/${client.slug}`);
}

/** Deletes the client only; its projects become unassigned. */
export async function deleteClientAction(clientId: string): Promise<void> {
  const user = await requireUser();
  if (isUuid(clientId)) await deleteClient(getDb(), user.id, clientId);
  revalidatePath('/clients');
  redirect('/clients');
}

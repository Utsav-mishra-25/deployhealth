'use server';

import { assertPublicUrl, BlockedUrlError, LimitExceededError } from '@deployhealth/core';
import { createEndpoint, deleteEndpoint, updateEndpoint } from '@deployhealth/db';
import { revalidatePath } from 'next/cache';
import { requireWritableUser } from '@/lib/guard';
import { getDb } from '@/lib/db';
import { enqueueAlertWebhook } from '@/lib/jobs';
import { endpointSaveRefusal } from '@/lib/endpoint-save-limit';
import { isUuid } from '@/lib/format';
import { endpointFormSchema, endpointFormValues, fieldErrors } from '@/lib/validation';

export type EndpointFormValues = ReturnType<typeof endpointFormValues>;

export type EndpointFormState =
  | { status: 'idle' }
  | { status: 'saved'; at: number }
  | { status: 'error'; message: string; fields: Record<string, string>; values: EndpointFormValues };

/** Create (endpointId = null) or update an endpoint. Limited per user; the URL must pass the SSRF guard. */
export async function saveEndpointAction(
  projectId: string,
  endpointId: string | null,
  _prev: EndpointFormState,
  form: FormData,
): Promise<EndpointFormState> {
  const user = await requireWritableUser();
  const values = endpointFormValues(form);
  const invalid = (message: string, fields: Record<string, string> = {}): EndpointFormState => ({
    status: 'error',
    message,
    fields,
    values,
  });
  if (!isUuid(projectId) || (endpointId !== null && !isUuid(endpointId))) return invalid('Endpoint not found.');

  const parsed = endpointFormSchema.safeParse(values);
  if (!parsed.success) return invalid('Please fix the highlighted fields.', fieldErrors(parsed.error));

  const refusal = endpointSaveRefusal(user.id);
  if (refusal) return invalid(refusal);

  let url: URL;
  try {
    url = await assertPublicUrl(parsed.data.url);
  } catch (error) {
    if (error instanceof BlockedUrlError) return invalid(error.message, { url: error.message });
    throw error;
  }

  const db = getDb();
  const input = { ...parsed.data, url: url.href };
  let saved;
  let event = null;
  try {
    if (endpointId) {
      const updated = await updateEndpoint(db, user.id, endpointId, input);
      saved = updated?.endpoint;
      event = updated?.event ?? null;
    } else {
      saved = await createEndpoint(db, user.id, projectId, input);
    }
  } catch (error) {
    if (error instanceof LimitExceededError) return invalid(error.message);
    throw error;
  }
  if (!saved) return invalid('Endpoint not found.');

  // Pausing resolved an open alert (already committed): the worker sends its webhook. A failed
  // enqueue loses only that message, so the save still succeeds.
  if (event) {
    try {
      await enqueueAlertWebhook({ projectId: event.projectId, type: event.type, message: event.message });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      console.error(`[alert] webhook not queued: ${(error as Error).name}${typeof code === 'string' ? ` ${code}` : ''}`);
    }
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/clients');
  return { status: 'saved', at: Date.now() };
}

export async function deleteEndpointAction(projectId: string, endpointId: string): Promise<void> {
  const user = await requireWritableUser();
  if (isUuid(endpointId)) await deleteEndpoint(getDb(), user.id, endpointId);
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/clients');
}

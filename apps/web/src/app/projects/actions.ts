'use server';

import { generateToken, githubActionSnippet, hashToken, tokenHint } from '@deployhealth/core';
import { BlockedUrlError, assertPublicUrl } from '@deployhealth/core';
import {
  assignProjectToClient,
  ClientNotFoundError,
  createClient,
  createProject,
  DuplicateProjectNameError,
  rotateProjectToken,
  updateProjectSettings,
} from '@deployhealth/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireWritableUser } from '@/lib/guard';
import { appUrl } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';

/** Returned once, right after a token is created. The plaintext token is never stored. */
export type TokenReveal = { projectId: string; projectName: string; token: string; snippet: string };

export type CreateProjectState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fields?: { name?: string; repoFullName?: string; clientId?: string; newClientName?: string } }
  | ({ status: 'created' } & TokenReveal);

const newProject = z.object({
  name: z.string().trim().min(1, 'Give the project a name').max(64, 'Keep it under 64 characters'),
  repoFullName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Use the owner/repo form, e.g. acme/storefront'),
});

/** Select value meaning "create a new client with the typed name". */
const NEW_CLIENT = '__new__';

export async function createProjectAction(_prev: CreateProjectState, form: FormData): Promise<CreateProjectState> {
  const user = await requireWritableUser();
  const parsed = newProject.safeParse({ name: form.get('name'), repoFullName: form.get('repoFullName') });
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    return { status: 'error', message: 'Please fix the highlighted fields.', fields };
  }

  const clientChoice = String(form.get('clientId') ?? '');
  const newClientName = String(form.get('newClientName') ?? '').trim();
  if (clientChoice === NEW_CLIENT && (newClientName.length === 0 || newClientName.length > 80)) {
    return { status: 'error', message: 'Please fix the highlighted fields.', fields: { newClientName: 'Name the new client (up to 80 characters)' } };
  }
  const existingClientId = clientChoice && clientChoice !== NEW_CLIENT ? clientChoice : null;
  if (existingClientId && !isUuid(existingClientId)) {
    return { status: 'error', message: 'Please fix the highlighted fields.', fields: { clientId: 'Pick a client from the list' } };
  }

  const db = getDb();
  const token = generateToken();
  try {
    // The project is created first so a duplicate name never leaves a stray new client behind.
    const project = await createProject(db, {
      ownerId: user.id,
      ...parsed.data,
      apiTokenHash: hashToken(token),
      apiTokenHint: tokenHint(token),
      clientId: existingClientId,
    });
    if (clientChoice === NEW_CLIENT) {
      const client = await createClient(db, user.id, { name: newClientName });
      await assignProjectToClient(db, user.id, project.id, client.id);
    }
    revalidatePath('/clients');
    return {
      status: 'created',
      projectId: project.id,
      projectName: project.name,
      token,
      snippet: githubActionSnippet({ appUrl: await appUrl() }),
    };
  } catch (error) {
    if (error instanceof DuplicateProjectNameError) {
      return { status: 'error', message: error.message, fields: { name: error.message } };
    }
    if (error instanceof ClientNotFoundError) {
      return { status: 'error', message: error.message, fields: { clientId: error.message } };
    }
    throw error;
  }
}

export type RegenerateState = { status: 'idle' } | { status: 'error'; message: string } | ({ status: 'created' } & TokenReveal);

export async function regenerateTokenAction(projectId: string, _prev: RegenerateState): Promise<RegenerateState> {
  const user = await requireWritableUser();
  if (!isUuid(projectId)) return { status: 'error', message: 'Project not found.' };

  const token = generateToken();
  const ok = await rotateProjectToken(getDb(), projectId, user.id, {
    apiTokenHash: hashToken(token),
    apiTokenHint: tokenHint(token),
  });
  if (!ok) return { status: 'error', message: 'Project not found.' };

  revalidatePath(`/projects/${projectId}/settings`);
  return { status: 'created', projectId, projectName: '', token, snippet: githubActionSnippet({ appUrl: await appUrl() }) };
}

export type SettingsState =
  | { status: 'idle' }
  | { status: 'saved' }
  | { status: 'error'; message: string; fields?: { clientId?: string; alertWebhookUrl?: string } };

/** Client assignment and alert webhook. The webhook URL passes the same SSRF guard as endpoints. */
export async function updateProjectSettingsAction(projectId: string, _prev: SettingsState, form: FormData): Promise<SettingsState> {
  const user = await requireWritableUser();
  if (!isUuid(projectId)) return { status: 'error', message: 'Project not found.' };

  const clientId = String(form.get('clientId') ?? '') || null;
  if (clientId && !isUuid(clientId)) return { status: 'error', message: 'Pick a client from the list', fields: { clientId: 'Pick a client from the list' } };

  const webhook = String(form.get('alertWebhookUrl') ?? '').trim() || null;
  if (webhook) {
    try {
      await assertPublicUrl(webhook);
    } catch (error) {
      if (error instanceof BlockedUrlError) {
        return { status: 'error', message: error.message, fields: { alertWebhookUrl: error.message } };
      }
      throw error;
    }
  }

  const ok = await updateProjectSettings(getDb(), user.id, projectId, { clientId, alertWebhookUrl: webhook });
  if (!ok) return { status: 'error', message: 'Project or client not found.' };
  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/clients');
  return { status: 'saved' };
}

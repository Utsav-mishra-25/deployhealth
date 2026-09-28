'use server';

import { generateToken, githubActionSnippet, hashToken, tokenHint } from '@deployhealth/core';
import { createProject, DuplicateProjectNameError, rotateProjectToken } from '@deployhealth/db';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireUser } from '@/auth';
import { appUrl } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';

/** Returned once, right after a token is created. The plaintext token is never stored. */
export type TokenReveal = { projectId: string; projectName: string; token: string; snippet: string };

export type CreateProjectState =
  | { status: 'idle' }
  | { status: 'error'; message: string; fields?: { name?: string; repoFullName?: string } }
  | ({ status: 'created' } & TokenReveal);

const newProject = z.object({
  name: z.string().trim().min(1, 'Give the project a name').max(64, 'Keep it under 64 characters'),
  repoFullName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'Use the owner/repo form, e.g. acme/storefront'),
});

export async function createProjectAction(_prev: CreateProjectState, form: FormData): Promise<CreateProjectState> {
  const user = await requireUser();
  const parsed = newProject.safeParse({ name: form.get('name'), repoFullName: form.get('repoFullName') });
  if (!parsed.success) {
    const fields = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
    return { status: 'error', message: 'Please fix the highlighted fields.', fields };
  }

  const token = generateToken();
  try {
    const project = await createProject(getDb(), {
      ownerId: user.id,
      ...parsed.data,
      apiTokenHash: hashToken(token),
      apiTokenHint: tokenHint(token),
    });
    revalidatePath('/projects');
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
    throw error;
  }
}

export type RegenerateState = { status: 'idle' } | { status: 'error'; message: string } | ({ status: 'created' } & TokenReveal);

export async function regenerateTokenAction(projectId: string, _prev: RegenerateState): Promise<RegenerateState> {
  const user = await requireUser();
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

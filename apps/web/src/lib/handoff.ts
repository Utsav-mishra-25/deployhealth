import { githubActionSnippet, renderHandoffMarkdown, type HandoffData } from '@deployhealth/core';
import { getHandoffData } from '@deployhealth/db';
import { appUrl } from '@/lib/app-url';
import { getDb } from '@/lib/db';
import { isUuid } from '@/lib/format';

/** A project's handoff for its owner, with the Action snippet for this instance; null if not theirs. */
export async function loadHandoff(ownerId: string, projectId: string): Promise<HandoffData | null> {
  if (!isUuid(projectId)) return null;
  const source = await getHandoffData(getDb(), ownerId, projectId);
  if (!source) return null;
  return { ...source, actionSnippet: githubActionSnippet({ appUrl: await appUrl() }) };
}

/** The Markdown download: a file, never cached (it's private project data). */
export function handoffMarkdownResponse(data: HandoffData): Response {
  const slug = data.project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return new Response(renderHandoffMarkdown(data), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${slug}-handoff.md"`,
      'cache-control': 'private, no-store',
    },
  });
}

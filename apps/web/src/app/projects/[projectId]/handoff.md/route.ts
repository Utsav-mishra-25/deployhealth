import { requireUser } from '@/auth';
import { handoffMarkdownResponse, loadHandoff } from '@/lib/handoff';

export const dynamic = 'force-dynamic';

/** The handoff as a Markdown file. */
export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const user = await requireUser();
  const { projectId } = await params;
  const data = await loadHandoff(user.id, projectId);
  return data ? handoffMarkdownResponse(data) : new Response('Not found', { status: 404 });
}

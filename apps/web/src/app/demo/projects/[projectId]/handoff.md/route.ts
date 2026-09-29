import { findDemoOwner } from '@/lib/demo';
import { handoffMarkdownResponse, loadHandoff } from '@/lib/handoff';

export const dynamic = 'force-dynamic';

/** The demo project's handoff as Markdown. No session; 404 unless DEMO_PUBLIC=1. */
export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const demo = await findDemoOwner();
  if (!demo) return new Response('Not found', { status: 404 });
  const { projectId } = await params;
  const data = await loadHandoff(demo.id, projectId);
  return data ? handoffMarkdownResponse(data) : new Response('Not found', { status: 404 });
}

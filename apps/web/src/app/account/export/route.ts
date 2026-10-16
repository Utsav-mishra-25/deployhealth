import { exportUserData } from '@deployhealth/db';
import { redirect } from 'next/navigation';
import { exportFilename, exportRefusal, SIGNED_OUT_PATH } from '@/lib/account';
import { getDb } from '@/lib/db';
import { ReadOnlyDemoError, requireWritableUser } from '@/lib/guard';

export const dynamic = 'force-dynamic';

/**
 * "Export my data" on /account: the signed-in user's data as a JSON download (exportUserData in
 * @deployhealth/db: owner-scoped, no tokens, no webhook URLs, never values). The demo user is
 * refused; at most EXPORTS_PER_WINDOW per user per window.
 */
export async function GET(): Promise<Response> {
  let user;
  try {
    user = await requireWritableUser();
  } catch (error) {
    if (error instanceof ReadOnlyDemoError) return text(403, error.message);
    throw error;
  }
  const refusal = exportRefusal(user.id);
  if (refusal) return text(429, refusal);
  const data = await exportUserData(getDb(), user.id);
  if (!data) redirect(SIGNED_OUT_PATH);
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${exportFilename(new Date(data.exportedAt))}"`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

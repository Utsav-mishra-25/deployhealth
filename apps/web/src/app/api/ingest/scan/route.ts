import { findProjectByTokenHash, recordScan } from '@deployhealth/db';
import { getDb } from '@/lib/db';
import { handleIngest } from '@/lib/ingest-handler';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  return handleIngest(request, {
    findProjectByTokenHash: (hash) => findProjectByTokenHash(db, hash),
    recordScan: (input) => recordScan(db, input),
  });
}

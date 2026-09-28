// Railway's deploy healthcheck. Deliberately does not touch the database.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true });
}

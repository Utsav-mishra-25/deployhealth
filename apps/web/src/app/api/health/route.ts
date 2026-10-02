// Railway's deploy healthcheck. Deliberately does not touch the database, logs nothing and isn't
// rate-limited: Railway calls it on every deploy.
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ ok: true });
}

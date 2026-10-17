# The backup service (docs/deploy-railway.md, step 15): the worker package plus pg_dump and
# pg_restore 18, run by Railway cron as `node apps/worker/dist/backup.js`. The worker service itself
# doesn't use this file: it builds with Railpack, unchanged. Build context: the repository root.
FROM node:22-bookworm-slim

# Production Postgres is major version 18, and pg_dump must be at least the server's major version,
# so the client is pinned to 18 from the PostgreSQL project's apt repository (Debian's own stops at
# 15). Bump it with a Postgres major upgrade; the backup checks the versions before every dump.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-18 \
  && apt-get purge -y curl \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/* \
  && pg_dump --version

WORKDIR /app
# pnpm at the version in package.json's packageManager field.
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @deployhealth/worker... \
  && pnpm --filter @deployhealth/worker... build

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/backup.js"]

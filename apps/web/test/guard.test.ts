import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEMO = { id: '0d3e0000-0000-4000-8000-00000000aaaa', login: 'demo' };
const OTHER = { id: '0d3e0000-0000-4000-8000-00000000bbbb', login: 'someone' };
const session = { user: DEMO };
const dbCalls: string[] = [];

vi.mock('@/auth', () => ({
  requireUser: async () => session.user,
  auth: async () => ({ user: session.user }),
  signIn: async () => {},
  signOut: async () => {},
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`unexpected redirect to ${url}`);
  },
  notFound: () => {
    throw new Error('unexpected notFound()');
  },
}));
// Every query function becomes a trap: an action that touches the database before the guard
// fails the test. Only isDemoUser (the guard's own lookup) is answered.
vi.mock('@deployhealth/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const trapped = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === 'function' && /^[a-z]/.test(name)
        ? () => {
            dbCalls.push(name);
            throw new Error(`unexpected database call: ${name}`);
          }
        : value,
    ]),
  );
  return { ...trapped, isDemoUser: async (_db: unknown, userId: string) => userId === DEMO.id };
});

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const DIRECTIVE = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/;
const files = sourceFiles(SRC);
const actionModules = files.filter((file) => DIRECTIVE.test(readFileSync(file, 'utf8')));
const inlineActionFiles = files
  .filter((file) => !actionModules.includes(file) && /['"]use server['"]/.test(readFileSync(file, 'utf8')))
  .map((file) => path.relative(SRC, file))
  .sort();

async function exportedActions(): Promise<Array<[string, (...args: unknown[]) => Promise<unknown>]>> {
  const found: Array<[string, (...args: unknown[]) => Promise<unknown>]> = [];
  for (const file of actionModules) {
    const mod = (await import(file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') found.push([`${path.relative(SRC, file)}#${name}`, value as (...args: unknown[]) => Promise<unknown>]);
    }
  }
  return found;
}

beforeEach(() => {
  session.user = DEMO;
  dbCalls.length = 0;
});

describe('read-only guard for the public demo user', () => {
  it('finds every server action module', async () => {
    const names = (await exportedActions()).map(([name]) => name);
    // A floor, so the test can't pass by discovering nothing. New actions are picked up automatically.
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toEqual(expect.arrayContaining(['app/projects/actions.ts#createProjectAction', 'app/clients/actions.ts#deleteClientAction']));
  });

  it('rejects every exported server action for the demo user before touching the database', async () => {
    const { ReadOnlyDemoError } = await import('@/lib/guard');
    const form = new FormData();
    form.set('name', 'x');
    const uuid = '0d3e0000-0000-4000-8000-000000000001';
    for (const [name, action] of await exportedActions()) {
      // Arguments cover every current signature (ids, previous state, form data); the guard runs first.
      const result = action(uuid, uuid, { status: 'idle' }, form);
      await expect(result, name).rejects.toBeInstanceOf(ReadOnlyDemoError);
    }
    expect(dbCalls).toEqual([]);
  });

  it('lets other users through', async () => {
    const { requireWritableUser } = await import('@/lib/guard');
    session.user = OTHER;
    await expect(requireWritableUser()).resolves.toEqual(OTHER);
  });

  it('knows every file with inline server actions (sign-in and sign-out only, which write no data)', () => {
    expect(inlineActionFiles).toEqual(['app/layout.tsx', 'app/login/page.tsx']);
  });
});

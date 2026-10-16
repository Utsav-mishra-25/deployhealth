import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmationMatches, DELETED_PATH, DELETION_CONSEQUENCES, EXPORTS_PER_WINDOW, exportFilename, exportRefusal, SIGNED_OUT_PATH } from '@/lib/account';

// The account page: export, deletion, and a session whose account is gone. Auth and the database
// are mocked; the queries themselves are tested in packages/db (export, delete-user, isolation).
const ALICE = { id: '0d3e0000-0000-4000-8000-00000000a11c', login: 'Alice' };
const DEMO = { id: '0d3e0000-0000-4000-8000-00000000aaaa', login: 'demo' };
const state = { session: { user: ALICE } as { user: typeof ALICE } | null, existing: new Set([ALICE.id, DEMO.id]) };
const calls: string[] = [];

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}) }));
vi.mock('next-auth', () => ({
  default: () => ({
    handlers: {},
    auth: async () => state.session,
    signIn: async () => {},
    signOut: async ({ redirectTo }: { redirectTo: string }) => {
      calls.push(`signOut ${redirectTo}`);
      throw new Redirect(redirectTo);
    },
  }),
}));
vi.mock('@deployhealth/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    userExists: async (_db: unknown, id: string) => state.existing.has(id),
    isDemoUser: async (_db: unknown, id: string) => id === DEMO.id,
    exportUserData: async (_db: unknown, id: string) => {
      calls.push(`export ${id}`);
      return { format: 'deployhealth-export/1', exportedAt: '2026-10-16T12:00:00.000Z', account: { login: 'Alice' } };
    },
    deleteOwnAccount: async (_db: unknown, id: string) => {
      calls.push(`delete ${id}`);
      if (id === DEMO.id) throw new (actual.UserDeletionError as new (m: string) => Error)('demo');
      state.existing.delete(id);
    },
  };
});

beforeEach(() => {
  state.session = { user: ALICE };
  state.existing = new Set([ALICE.id, DEMO.id]);
  calls.length = 0;
});

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Redirect);
  return (error as Redirect).url;
}

describe('the account page helpers', () => {
  it('confirms with the GitHub login, ignoring case and spaces', () => {
    expect(confirmationMatches(' alice ', 'Alice')).toBe(true);
    expect(confirmationMatches('alice2', 'Alice')).toBe(false);
    expect(confirmationMatches(null, 'Alice')).toBe(false);
  });

  it('names the export by UTC date', () => {
    expect(exportFilename(new Date('2026-10-16T23:30:00-05:00'))).toBe('deployhealth-export-2026-10-17.json');
  });

  it(`allows ${EXPORTS_PER_WINDOW} exports per user per window`, () => {
    for (let i = 0; i < EXPORTS_PER_WINDOW; i++) expect(exportRefusal('limit-user')).toBeNull();
    expect(exportRefusal('limit-user')).toMatch(/^Too many exports/);
    expect(exportRefusal('another-user')).toBeNull();
  });

  it('says what deletion means for clients: share links and pull request checks', () => {
    const text = DELETION_CONSEQUENCES.join(' ');
    expect(text).toMatch(/report links .* stop working/);
    expect(text).toMatch(/Pull request checks stop/);
    expect(text).toMatch(/Uninstall it on GitHub/);
  });
});

describe('GET /account/export', () => {
  it("downloads the signed-in user's data as JSON, never cached", async () => {
    const { GET } = await import('@/app/account/export/route');
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="deployhealth-export-2026-10-16.json"');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(await response.text())).toMatchObject({ format: 'deployhealth-export/1' });
    expect(calls).toEqual([`export ${ALICE.id}`]);
  });

  it('refuses the demo user before reading anything', async () => {
    state.session = { user: DEMO };
    const { GET } = await import('@/app/account/export/route');
    const response = await GET();
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('sends a signed-out visitor to /login', async () => {
    state.session = null;
    const { GET } = await import('@/app/account/export/route');
    expect(await redirectOf(GET())).toBe('/login');
  });
});

describe('deleteMyAccount', () => {
  const form = (confirm: string) => {
    const data = new FormData();
    data.set('confirm', confirm);
    return data;
  };

  it('deletes after the login is typed, then signs this browser out onto the deleted page', async () => {
    const { deleteMyAccount } = await import('@/app/account/actions');
    expect(await redirectOf(deleteMyAccount(form('alice')))).toBe(DELETED_PATH);
    expect(calls).toEqual([`delete ${ALICE.id}`, `signOut ${DELETED_PATH}`]);
  });

  it('deletes nothing when the confirmation is wrong', async () => {
    const { deleteMyAccount } = await import('@/app/account/actions');
    expect(await redirectOf(deleteMyAccount(form('bob')))).toBe('/account?delete=mismatch#delete-account');
    expect(calls).toEqual([]);
  });

  it('refuses the demo user before reading the form (the read-only guard)', async () => {
    state.session = { user: DEMO };
    const { deleteMyAccount } = await import('@/app/account/actions');
    await expect(deleteMyAccount(form('demo'))).rejects.toThrow(/read-only/);
    expect(calls).toEqual([]);
  });
});

describe('a session whose account was deleted', () => {
  it('is sent to the sign-out route by requireUser(), not into an error', async () => {
    state.existing.delete(ALICE.id);
    const { requireUser } = await import('@/auth');
    expect(await redirectOf(requireUser())).toBe(SIGNED_OUT_PATH);
  });

  it('is signed out there and lands on the deleted page', async () => {
    state.existing.delete(ALICE.id);
    const { GET } = await import('@/app/account/signed-out/route');
    expect(await redirectOf(GET())).toBe(DELETED_PATH);
    expect(calls).toEqual([`signOut ${DELETED_PATH}`]);
  });

  it("the sign-out route never signs out a session whose account exists", async () => {
    const { GET } = await import('@/app/account/signed-out/route');
    expect(await redirectOf(GET())).toBe('/clients');
    expect(calls).toEqual([]);
  });
});

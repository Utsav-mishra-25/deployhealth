import { planOwnAccountDeletion, UserDeletionError, type UserDeletion } from '@deployhealth/db';
import type { Metadata } from 'next';
import { requireUser } from '@/auth';
import { AccountData, type DeleteProblem } from '@/components/account-data';
import { getDb } from '@/lib/db';

export const metadata: Metadata = { title: 'Account · deployhealth' };

export const dynamic = 'force-dynamic';

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ delete?: string }> }) {
  const user = await requireUser();
  const { delete: outcome } = await searchParams;
  const problem: DeleteProblem = outcome === 'mismatch' || outcome === 'refused' ? outcome : null;
  let plan: UserDeletion | null = null;
  try {
    plan = await planOwnAccountDeletion(getDb(), user.id);
  } catch (error) {
    if (!(error instanceof UserDeletionError)) throw error;
  }
  return (
    <div className="max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="mt-1 text-sm text-gray-600">
          Signed in with GitHub as <strong className="break-all">{user.login}</strong>.
        </p>
      </div>
      <AccountData login={user.login} plan={plan} problem={problem} />
    </div>
  );
}

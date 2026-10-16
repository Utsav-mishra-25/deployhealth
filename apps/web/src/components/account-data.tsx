import { DELETION_TABLE_LABELS, DELETION_TABLES, type UserDeletion } from '@deployhealth/db';
import { deleteMyAccount } from '@/app/account/actions';
import { DELETION_CONSEQUENCES, EXPORT_DESCRIPTION, EXPORT_PATH } from '@/lib/account';

export type DeleteProblem = 'mismatch' | 'refused' | null;

/**
 * The account page's two sections, "Export your data" and "Delete your account", as one unit, so
 * it can sit on whichever account or settings page the app has. Server component: plain links and
 * a plain form, no JavaScript needed. `plan` is null when this account can't be deleted here (the
 * local dev user).
 */
export function AccountData({ login, plan, problem }: { login: string; plan: UserDeletion | null; problem: DeleteProblem }) {
  return (
    <div className="space-y-10">
      <section aria-labelledby="export-data">
        <h2 id="export-data" className="text-lg font-semibold">
          Export your data
        </h2>
        <p className="mt-1 mb-3 text-sm text-gray-600">{EXPORT_DESCRIPTION}</p>
        <a
          href={EXPORT_PATH}
          download
          className="inline-block rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
          data-testid="export-data"
        >
          Export my data
        </a>
      </section>

      <section aria-labelledby="delete-account-heading" id="delete-account">
        <h2 id="delete-account-heading" className="text-lg font-semibold">
          Delete your account
        </h2>
        {plan ? <DeleteForm login={login} plan={plan} problem={problem} /> : <p className="mt-1 text-sm text-gray-600">This account can&apos;t be deleted here: it&apos;s the local dev user.</p>}
      </section>
    </div>
  );
}

function DeleteForm({ login, plan, problem }: { login: string; plan: UserDeletion; problem: DeleteProblem }) {
  const goes = DELETION_TABLES.filter((table) => table !== 'users' && plan.counts[table] > 0);
  return (
    <div className="mt-1 space-y-4 text-sm text-gray-700">
      <p>Deleting your account removes, at once and for good, in one step:</p>
      <ul className="list-disc space-y-1 pl-5" data-testid="deletion-list">
        <li>{DELETION_TABLE_LABELS.users}</li>
        {goes.map((table) => (
          <li key={table}>
            {DELETION_TABLE_LABELS[table]}: <span className="tabular-nums">{plan.counts[table]}</span>
          </li>
        ))}
      </ul>
      <p>What it means for your clients and your GitHub accounts:</p>
      <ul className="list-disc space-y-1 pl-5" data-testid="deletion-consequences">
        {DELETION_CONSEQUENCES.map((line) => (
          <li key={line}>{line}</li>
        ))}
        {plan.installationAccounts.organization > 0 && (
          <li>
            The App is installed on {plan.installationAccounts.organization} organization{plan.installationAccounts.organization === 1 ? '' : 's'} from your
            account: tell their owners pull request checks stop there.
          </li>
        )}
      </ul>
      <form action={deleteMyAccount} className="space-y-3 rounded-lg border border-red-200 bg-white p-4">
        <label htmlFor="confirm" className="block">
          To confirm, type your GitHub login, <strong className="break-all">{login}</strong>:
        </label>
        <input
          id="confirm"
          name="confirm"
          required
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          className="block w-full max-w-xs rounded-md border border-gray-300 px-3 py-2"
          aria-describedby={problem ? 'delete-problem' : undefined}
        />
        {problem && (
          <p id="delete-problem" role="alert" className="text-red-700">
            {problem === 'mismatch' ? `That isn't ${login}. Nothing was deleted.` : "This account can't be deleted here. Nothing was deleted."}
          </p>
        )}
        <button type="submit" className="rounded-md bg-red-700 px-3 py-2 font-medium text-white hover:bg-red-800" data-testid="delete-account">
          Delete my account
        </button>
      </form>
    </div>
  );
}

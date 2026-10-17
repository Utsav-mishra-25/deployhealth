import type { Check } from '@deployhealth/db';
import { ChecksTable } from './checks-table';

/** Rows of an endpoint's recent checks shown before "Show all checks". */
export const RECENT_CHECKS_SHOWN = 5;

/** An endpoint's latest checks: the first few, the rest inside a closed <details>. */
export function RecentChecks({ checks }: { checks: Check[] }) {
  const rest = checks.slice(RECENT_CHECKS_SHOWN);
  return (
    <>
      <div className="overflow-x-auto">
        <ChecksTable checks={checks.slice(0, RECENT_CHECKS_SHOWN)} />
      </div>
      {rest.length > 0 && (
        <details className="mt-2" data-testid="more-checks">
          <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-900">Show all checks</summary>
          <div className="mt-2 overflow-x-auto">
            <ChecksTable checks={rest} />
          </div>
        </details>
      )}
    </>
  );
}

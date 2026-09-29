import { shiftMonth, type ReportMonth } from '@deployhealth/core';
import Link from 'next/link';
import { PrintButton } from './print-button';

/** Back link, month navigation, print and (for the owner) share. Hidden when printing. */
export function ReportToolbar({
  backHref,
  backLabel,
  month,
  monthHref,
  now,
  share,
}: {
  backHref: string;
  backLabel: string;
  month: ReportMonth;
  monthHref: (key: string) => string;
  now: Date;
  share?: React.ReactNode;
}) {
  const previous = shiftMonth(month, -1);
  const next = shiftMonth(month, 1);
  const link = 'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium hover:bg-gray-50';
  return (
    <>
      <Link href={backHref} className="text-sm text-gray-600 hover:text-gray-900">
        ← {backLabel}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={monthHref(previous.key)} className={link} aria-label={`Report for ${previous.label}`}>
          ← {previous.label}
        </Link>
        {next.from.getTime() <= now.getTime() && (
          <Link href={monthHref(next.key)} className={link} aria-label={`Report for ${next.label}`}>
            {next.label} →
          </Link>
        )}
        {share}
        <PrintButton />
      </div>
    </>
  );
}

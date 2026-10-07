'use client';

/** The PDF path: the browser's print dialog ("Save as PDF"). No PDF library involved. */
export function PrintButton({ label = 'Print or save as PDF' }: { label?: string }) {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-800">
      {label}
    </button>
  );
}

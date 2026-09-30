/** The layout of the static public pages (/security, /privacy, /terms): a card with titled sections. */
export function ProsePage({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <article className="mx-auto max-w-3xl space-y-10 rounded-lg border border-gray-200 bg-white p-5 sm:p-8" data-testid={testId}>
      {children}
    </article>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-gray-700">{children}</div>
    </section>
  );
}

/** Class for list items in these pages. */
export const li = 'ml-5 list-disc';

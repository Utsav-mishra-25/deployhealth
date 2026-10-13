import { LANGUAGES_SENTENCE } from '@deployhealth/core';
import type { Metadata } from 'next';
import { Prose, StackLinks, TryItSection } from '@/components/docs-page';
import { DOCS_INDEX } from '@/lib/docs-pages';

export const metadata: Metadata = {
  title: DOCS_INDEX.title,
  description: DOCS_INDEX.description,
  alternates: { canonical: '/docs' },
};

/** Public: what deployhealth checks, the languages it reads, and the stack pages. No user data. */
export default function DocsIndexPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-10" data-testid="docs-index">
      <header className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{DOCS_INDEX.h1}</h1>
        {DOCS_INDEX.intro.map((p) => (
          <p key={p} className="leading-relaxed text-gray-700">
            <Prose text={p} />
          </p>
        ))}
        <p className="text-sm text-gray-600">{LANGUAGES_SENTENCE}</p>
      </header>
      <section aria-labelledby="stacks" className="space-y-3">
        <h2 id="stacks" className="text-lg font-semibold">
          By stack
        </h2>
        <StackLinks />
      </section>
      <TryItSection />
    </article>
  );
}

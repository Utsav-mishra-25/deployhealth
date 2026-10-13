import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { StackDocView } from '@/components/docs-page';
import { DOCS_SLUGS, STACK_DOCS, type DocsSlug } from '@/lib/docs-pages';

// Only the stacks in lib/docs-pages.ts exist; anything else is a 404, never rendered on demand.
export const dynamicParams = false;

export function generateStaticParams() {
  return DOCS_SLUGS.map((stack) => ({ stack }));
}

const isSlug = (value: string): value is DocsSlug => (DOCS_SLUGS as readonly string[]).includes(value);

export async function generateMetadata({ params }: { params: Promise<{ stack: string }> }): Promise<Metadata> {
  const { stack } = await params;
  if (!isSlug(stack)) return {};
  const doc = STACK_DOCS[stack];
  return { title: doc.title, description: doc.description, alternates: { canonical: `/docs/${stack}` } };
}

/** Public: how deployhealth catches a missing env var in one stack. Static, no user data. */
export default async function StackDocsPage({ params }: { params: Promise<{ stack: string }> }) {
  const { stack } = await params;
  if (!isSlug(stack)) notFound();
  return <StackDocView doc={STACK_DOCS[stack]} />;
}

import type { Metadata } from 'next';
import { demoOwner } from '@/lib/demo';
import { DEMO_PATHS } from '@/lib/paths';
import { clientMetadata } from '@/lib/titles';
import { ClientView } from '@/views/client-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return clientMetadata('demo', (await demoOwner()).id, slug);
}

export default async function DemoClientPage({ params }: { params: Promise<{ slug: string }> }) {
  const demo = await demoOwner();
  const { slug } = await params;
  return <ClientView ownerId={demo.id} slug={slug} paths={DEMO_PATHS} readOnly />;
}

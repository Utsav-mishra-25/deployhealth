import type { Metadata } from 'next';
import { DemoGuide } from '@/components/demo-guide';
import { demoOwner } from '@/lib/demo';
import { DEMO_PATHS } from '@/lib/paths';
import { ClientsOverviewView } from '@/views/clients-overview';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Live demo · deployhealth' };

export default async function DemoClientsPage() {
  const demo = await demoOwner();
  return (
    <>
      <DemoGuide />
      <ClientsOverviewView ownerId={demo.id} paths={DEMO_PATHS} readOnly />
    </>
  );
}

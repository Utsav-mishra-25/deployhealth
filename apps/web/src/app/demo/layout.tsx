import { DemoBanner } from '@/components/demo-banner';
import { demoOwner } from '@/lib/demo';

/** The public, read-only demo. No session needed; 404 unless DEMO_PUBLIC=1. */
export default async function DemoLayout({ children }: { children: React.ReactNode }) {
  await demoOwner();
  return (
    <>
      <DemoBanner />
      {children}
    </>
  );
}

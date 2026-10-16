import Link from 'next/link';
import { DEMO_GUIDE } from '@/lib/marketing';

/** /demo, under the banner: three places to look first, each a link. */
export function DemoGuide() {
  const link = 'font-medium text-emerald-700 underline';
  return (
    <nav aria-labelledby="demo-guide-heading" className="mb-8 rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm" data-testid="demo-guide">
      <h2 id="demo-guide-heading" className="font-semibold">
        Where to look
      </h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-gray-700">
        <li>
          <Link href={DEMO_GUIDE.projects.href} className={link}>
            {DEMO_GUIDE.projects.label}
          </Link>{' '}
          ({DEMO_GUIDE.projects.note})
        </li>
        <li>
          <Link href={DEMO_GUIDE.deploy.href} className={link}>
            {DEMO_GUIDE.deploy.label}
          </Link>{' '}
          ({DEMO_GUIDE.deploy.note})
        </li>
        <li>
          <Link href={DEMO_GUIDE.report.href} className={link}>
            {DEMO_GUIDE.report.label}
          </Link>
          , and{' '}
          <Link href={DEMO_GUIDE.handoff.href} className={link}>
            {DEMO_GUIDE.handoff.label}
          </Link>
        </li>
      </ol>
    </nav>
  );
}

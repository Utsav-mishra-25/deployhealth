import { LANGUAGES_SENTENCE } from '@deployhealth/core';
import Link from 'next/link';
import { FAQ } from '@/lib/marketing';

/** Plain <details>: opens and closes without JavaScript. */
export function Faq() {
  return (
    <div className="divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white" data-testid="faq">
      {FAQ.map((item) => (
        <details key={item.question} className="group px-5 py-4">
          <summary className="cursor-pointer font-medium marker:text-gray-500">{item.question}</summary>
          <div className="mt-2 space-y-2 text-sm leading-relaxed text-gray-700">
            <p>
              {item.answer}
              {'link' in item && (
                <>
                  {' '}
                  <Link href={item.link.href} className="text-emerald-700 underline">
                    {item.link.label}
                  </Link>
                </>
              )}
            </p>
            {'languages' in item && <p data-testid="faq-languages">{LANGUAGES_SENTENCE}</p>}
          </div>
        </details>
      ))}
    </div>
  );
}

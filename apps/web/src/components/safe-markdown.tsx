import Markdown, { type Components } from 'react-markdown';

const components: Components = {
  a: ({ href, children }) => {
    const external = typeof href === 'string' && /^https?:\/\//i.test(href);
    return (
      <a href={href} className="text-emerald-700 underline" {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {children}
      </a>
    );
  },
};

/**
 * Markdown written by users (deploy notes), rendered as untrusted content: raw HTML is dropped
 * (skipHtml; no rehype-raw), images are removed (no external requests, no tracking pixels),
 * external links get rel="noopener noreferrer", and react-markdown's default URL transform strips
 * javascript: and other unsafe link targets. Server-rendered, so it ships no JavaScript.
 */
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown skipHtml disallowedElements={['img']} components={components}>
        {children}
      </Markdown>
    </div>
  );
}

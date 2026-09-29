import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SafeMarkdown } from '@/components/safe-markdown';

const render = (markdown: string) => renderToStaticMarkup(createElement(SafeMarkdown, null, markdown));

describe('SafeMarkdown (deploy notes are untrusted)', () => {
  it('renders ordinary Markdown', () => {
    const html = render('## Deploy\n\n1. Push to `main`\n2. Run **migrations**');
    expect(html).toContain('<h2>Deploy</h2>');
    expect(html).toContain('<code>main</code>');
    expect(html).toContain('<strong>migrations</strong>');
  });

  it('drops raw HTML instead of passing it through', () => {
    const html = render('Hi <script>alert(1)</script> <b onclick="steal()">bold</b>\n\n<iframe src="https://evil.example"></iframe>');
    expect(html).not.toMatch(/<script|<iframe|<b[ >]|onclick/i);
    expect(html).toContain('Hi');
  });

  it('removes images entirely, including Markdown ones', () => {
    const html = render('![pixel](https://tracker.example/p.gif) and <img src="https://tracker.example/q.gif">');
    expect(html).not.toMatch(/<img|tracker\.example/);
  });

  it('opens external links with rel="noopener noreferrer" and strips javascript: URLs', () => {
    const html = render('[docs](https://railway.com/docs) [local](/clients) [bad](javascript:alert(1))');
    expect(html).toContain('<a href="https://railway.com/docs" class="text-emerald-700 underline" target="_blank" rel="noopener noreferrer">docs</a>');
    expect(html).toContain('<a href="/clients" class="text-emerald-700 underline">local</a>');
    expect(html).not.toContain('javascript:');
  });
});

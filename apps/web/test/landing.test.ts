import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LANGUAGES_SENTENCE, SUPPORTED_LANGUAGES, UNREAD_LANGUAGES_TEXT } from '@deployhealth/core';
import { demoDeploys, SCENARIO } from '@deployhealth/db/seed';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { alt as ogImageAlt } from '@/app/opengraph-image';
import { Landing, LANDING_SCREENSHOT } from '@/components/landing';
import { LANDING_DEPLOY_SHA, LANDING_PAGE_METADATA as landingMetadata, landingAlertMessage } from '@/lib/landing';
import { FAQ, FAQ_STACK_SENTENCE, HERO, HOW_IT_WORKS, LANDING_METADATA, TAGLINE, WHO_FOR } from '@/lib/marketing';

const render = (demo: boolean) => renderToStaticMarkup(createElement(Landing, { demo }));
/** React escapes apostrophes and quotes in text. */
const escaped = (text: string) => text.replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

describe('the landing page example alert', () => {
  it('is the demo incident, worded by the real alert message builder', () => {
    expect(landingAlertMessage()).toBe('Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY');
  });

  it("names the seed's incident deploy and endpoint, so the demo link shows the same story", () => {
    expect(demoDeploys(new Date()).at(-1)!.sha).toBe(LANDING_DEPLOY_SHA);
    expect(landingAlertMessage()).toContain(`${SCENARIO.endpointName} started failing ${SCENARIO.failureAfterDeployMinutes}m after`);
  });
});

describe('the landing page order', () => {
  it('opens on the hero, then the screenshot, then the alert, who it is for, setup, pricing, questions, trust', () => {
    const html = render(true);
    const order = [
      '<h1',
      'data-testid="landing-subline"',
      'See the live demo',
      'data-testid="landing-free"',
      'data-testid="landing-screenshot"',
      'What an alert looks like (live from the demo)',
      'role="alert"',
      'Who it&#x27;s for',
      'How it works',
      'id="pricing-heading"',
      'id="faq-heading"',
      'aria-label="Trust"',
    ].map((needle) => [needle, html.indexOf(needle)] as const);
    for (const [needle, at] of order) expect(at, needle).toBeGreaterThan(-1);
    for (let i = 1; i < order.length; i++) expect(order[i]![1], `${order[i]![0]} after ${order[i - 1]![0]}`).toBeGreaterThan(order[i - 1]![1]);
  });

  it("labels the alert as an example of what's sent, never as an alert that was posted (the demo has no webhook)", () => {
    for (const demo of [true, false]) {
      const html = render(demo);
      expect(html).toContain('Alerts like this go to Slack or Discord.');
      expect(html).not.toMatch(/posted to Slack/i);
    }
  });

  it('without the public demo: no demo button or link, sign-in is the primary button, the alert is an example', () => {
    const html = render(false);
    expect(html).not.toContain('See the live demo');
    expect(html).not.toContain('href="/demo');
    expect(html).toContain('What an alert looks like</h2>');
    expect(html).toMatch(/class="[^"]*bg-emerald-700[^"]*"[^>]*>Sign in with GitHub/);
  });
});

describe('the landing hero', () => {
  it('leads with the freelancer story, the buttons, the docs link, then free during the beta', () => {
    expect(HERO.headline).toBe("Know which deploy broke your client's site, before they call you.");
    expect(HERO.subline).toBe(
      'deployhealth checks every pull request for config your code needs but nobody declared, watches your sites, and ties each outage to the deploy that caused it. Monthly reports your clients can read.',
    );
    const html = render(true);
    expect(html).toContain(`>${escaped(HERO.headline)}</h1>`);
    expect(html).toContain(HERO.subline);
    expect(html).toContain('href="/docs"');
    expect(html).toContain('Docs: Next.js, Laravel, Spring Boot');
    expect(html).toContain('Free during the beta.');
    expect(html).not.toContain('Free while in beta');
  });

  it('keeps the languages sentence out of the page: the FAQ says it in one line instead', () => {
    const html = render(true);
    expect(html).not.toContain(escaped(LANGUAGES_SENTENCE));
    const hero = html.slice(html.indexOf('data-testid="landing-hero"'), html.indexOf('data-testid="landing-screenshot"'));
    expect(hero).not.toMatch(/Reads JS\/TS|Supported today/);
    const faq = html.slice(html.indexOf('data-testid="faq"'));
    expect(faq).toContain(escaped(FAQ_STACK_SENTENCE));
  });
});

describe('who it is for', () => {
  it('has the freelancer column first, with the login page line, then small teams with the Dependabot comparison', () => {
    expect(WHO_FOR.map((g) => g.title)).toEqual(['Freelancers and agencies', 'Small dev teams']);
    expect(WHO_FOR[0].lead).toBe(TAGLINE);
    expect(TAGLINE).toBe('One page for every client project you maintain.');
    expect(WHO_FOR[0].points.join(' ')).toMatch(/monthly report per client.*share link/);
    expect(WHO_FOR[0].points.join(' ')).toMatch(/handoff doc when the project ends/);
    expect(WHO_FOR[1].lead).toBe('Like Dependabot, but for your .env.example.');
    expect(WHO_FOR[1].points.join(' ')).toMatch(/comment and a check on every pull request/);
    expect(WHO_FOR[1].points.join(' ')).toMatch(/Strict mode .*block the merge/);
    expect(WHO_FOR[1].points.join(' ')).toMatch(/name the deploy .*what it changed/);
  });

  it('makes no claim of affiliation and carries no marks: the only image is the product screenshot', () => {
    const html = render(true);
    expect(html).not.toMatch(/endorsed|partner|official|affiliat|<svg/i);
    expect(html.match(/<img/g)).toHaveLength(1);
    expect(html).toContain(`src="${LANDING_SCREENSHOT.src}"`);
  });
});

describe('how it works', () => {
  it('matches the real setup: the App first (no token), then sites, then the optional Action; no "Plus:" line', () => {
    expect(HOW_IT_WORKS.map((s) => s.title)).toEqual(['Install the GitHub App', 'Add your sites', 'Optional: add the Action']);
    expect(HOW_IT_WORKS[0].body).toMatch(/no token or workflow/);
    expect(HOW_IT_WORKS[1].body).toMatch(/every minute.*Slack or Discord/);
    expect(HOW_IT_WORKS[2].body).toMatch(/deploy history and alerts that name the deploy/);
    expect(render(true)).not.toContain('Plus:');
    expect(render(false)).not.toContain('Plus:');
  });
});

describe('the FAQ', () => {
  it('is plain <details>, with the four questions in order', () => {
    const html = render(true);
    const questions = [...html.matchAll(/<summary[^>]*>([^<]+)<\/summary>/g)].map((m) => m[1]);
    expect(questions).toEqual(['Do you see my secrets?', 'Do I have to change my code?', 'What if my stack isn&#x27;t supported?', 'What does it cost after the beta?']);
    expect(html.match(/<details/g)).toHaveLength(4);
    expect(html).toContain('href="/security"');
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('including WordPress');
  });

  it("answers an unsupported stack with what works anywhere, then one line naming what's read, from core's list", () => {
    expect(FAQ_STACK_SENTENCE).toBe(
      'On Rust, C# and other languages we don\'t read yet, the PR check and CLI report "can\'t check" instead of passing. Supported today: JS/TS, Python, Go, Ruby, PHP, Java/Kotlin.',
    );
    expect(FAQ_STACK_SENTENCE.endsWith(`Supported today: ${SUPPORTED_LANGUAGES.map((l) => l.label).join(', ')}.`)).toBe(true);
    expect(FAQ_STACK_SENTENCE).toContain(UNREAD_LANGUAGES_TEXT.replace(' and others', ''));
    const stack = FAQ.find((item) => item.question === "What if my stack isn't supported?")!;
    expect(stack.answer).toBe(`Uptime checks, monthly reports and handoffs work for any site, including WordPress. ${FAQ_STACK_SENTENCE}`);
  });
});

describe('the landing page trust strip', () => {
  it('says values stay in CI (the CLI reads .env files locally), not that they are never read', () => {
    const html = render(true);
    expect(html).toContain('Your env values never leave your CI: we only see names and file:line. Response bodies are never read.');
    expect(html).not.toMatch(/Never reads your env values/i);
  });
});

describe('the landing screenshot', () => {
  it('is a committed PNG with its width, height and alt set, and stays small', () => {
    const file = join(__dirname, '..', 'public', LANDING_SCREENSHOT.src);
    const png = readFileSync(file);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([LANDING_SCREENSHOT.width, LANDING_SCREENSHOT.height]);
    expect(statSync(file).size).toBeLessThan(200 * 1024);
    const html = render(true);
    expect(html).toContain(`width="${LANDING_SCREENSHOT.width}" height="${LANDING_SCREENSHOT.height}"`);
    expect(LANDING_SCREENSHOT.alt).toMatch(/clients list/);
  });
});

describe('the landing page metadata', () => {
  it('matches the headline: title, description, Open Graph and the image alt', () => {
    expect(landingMetadata.title).toBe(LANDING_METADATA.title);
    expect(LANDING_METADATA.title.length).toBeLessThan(60);
    expect(LANDING_METADATA.description.length).toBeLessThan(155);
    expect(landingMetadata.openGraph?.title).toBe(HERO.headline);
    expect(landingMetadata.twitter?.title).toBe(HERO.headline);
    expect(ogImageAlt).toBe(`deployhealth: ${HERO.headline}`);
  });
});

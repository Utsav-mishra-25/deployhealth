import { DEMO_PROJECT_IDS, slugify } from '@deployhealth/db';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SITEMAP_PATHS } from '@/app/sitemap';
import { DemoGuide } from '@/components/demo-guide';
import { PricingPlans } from '@/components/pricing';
import { DEMO_GUIDE, DEMO_GUIDE_CLIENT_SLUG, FAQ_COST_ANSWER, PRICING, PRICING_METADATA } from '@/lib/marketing';
import { DEMO_PATHS } from '@/lib/paths';

/** Things deployhealth doesn't have, so neither the pricing block nor /pricing may mention them. */
const UNBUILT = /email alert|branded|white.?label|seats?\b|per seat|unlimited|up to \d|\blimits?\b|SSO|SLA/i;

describe('pricing', () => {
  it('says what is true today, then the planned prices, names and prices only', () => {
    const html = renderToStaticMarkup(createElement(PricingPlans, { headingLevel: 'h2' }));
    expect(PRICING.free).toBe('Free during the beta: everything you see in the demo.');
    expect(html).toContain(PRICING.free);
    expect(html).toContain('Freelancer');
    expect(html).toContain('$15/month');
    expect(html).toContain('Studio');
    expect(html).toContain('$29/month');
    expect(html).toContain('Beta users get advance notice and an early-user price.');
    expect(html.indexOf(PRICING.free)).toBeLessThan(html.indexOf('Freelancer'));
  });

  it('has no limits table and no unbuilt features', () => {
    const html = renderToStaticMarkup(createElement(PricingPlans, { headingLevel: 'h2' }));
    expect(html).not.toContain('<table');
    expect(html).not.toMatch(UNBUILT);
    expect(PRICING_METADATA.description).not.toMatch(UNBUILT);
    expect(FAQ_COST_ANSWER).not.toMatch(UNBUILT);
  });

  it('the FAQ answer and the page description agree with the plans', () => {
    for (const plan of PRICING.planned) {
      expect(FAQ_COST_ANSWER).toContain(`${plan.name} at ${plan.price}`);
      expect(PRICING_METADATA.description).toContain(`${plan.name} ${plan.price}`);
    }
  });

  it('is in the sitemap, with a title under 60 characters and a description under 155', () => {
    expect(SITEMAP_PATHS).toContain('/pricing');
    expect(PRICING_METADATA.title).toBe('Pricing · deployhealth');
    expect(PRICING_METADATA.description.length).toBeLessThan(155);
  });
});

describe('the demo guide', () => {
  it("points at the demo's list, the incident deploy, Acme's report and the storefront's handoff", () => {
    const storefront = DEMO_PROJECT_IDS.storefront;
    expect(DEMO_GUIDE.projects.href).toBe('/demo#projects');
    expect(DEMO_GUIDE.deploy.href).toBe(`${DEMO_PATHS.project(storefront)}#deploys`);
    expect(DEMO_GUIDE.report.href).toBe(DEMO_PATHS.clientReport(DEMO_GUIDE_CLIENT_SLUG));
    expect(DEMO_GUIDE.handoff.href).toBe(DEMO_PATHS.handoff(storefront));
    // The seed's client is "Acme Corp"; its slug comes from the same function the app uses.
    expect(slugify('Acme Corp')).toBe(DEMO_GUIDE_CLIENT_SLUG);
  });

  it('is three items, each a link', () => {
    const html = renderToStaticMarkup(createElement(DemoGuide));
    expect(html.match(/<li>/g)).toHaveLength(3);
    for (const target of Object.values(DEMO_GUIDE)) expect(html).toContain(`href="${target.href}"`);
    expect(html).toContain('The project list</a> (worst first)');
    expect(html).toContain('(acme-storefront)');
  });
});

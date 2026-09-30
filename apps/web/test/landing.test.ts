import { demoDeploys, SCENARIO } from '@deployhealth/db/seed';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Landing } from '@/components/landing';
import { LANDING_DEPLOY_SHA, landingAlertMessage } from '@/lib/landing';

describe('the landing page example alert', () => {
  it('is the demo incident, worded by the real alert message builder', () => {
    expect(landingAlertMessage()).toBe('Acme API started failing 4m after deploy b52952e, which introduced 2 missing env vars: REDIS_URL, STRIPE_KEY');
  });

  it("names the seed's incident deploy and endpoint, so the demo link shows the same story", () => {
    expect(demoDeploys(new Date()).at(-1)!.sha).toBe(LANDING_DEPLOY_SHA);
    expect(landingAlertMessage()).toContain(`${SCENARIO.endpointName} started failing ${SCENARIO.failureAfterDeployMinutes}m after`);
  });
});

describe('the landing page trust strip', () => {
  it('says values stay in CI (the CLI reads .env files locally), not that they are never read', () => {
    const html = renderToStaticMarkup(createElement(Landing, { demo: true }));
    expect(html).toContain('Your env values never leave your CI: we only see names and file:line. Response bodies are never read.');
    expect(html).not.toMatch(/Never reads your env values/i);
    expect(html).toContain('href="/security"');
  });
});

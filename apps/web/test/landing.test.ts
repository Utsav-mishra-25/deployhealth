import { demoDeploys, SCENARIO } from '@deployhealth/db/seed';
import { describe, expect, it } from 'vitest';
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

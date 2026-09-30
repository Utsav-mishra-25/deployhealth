import { alertOpenedMessage } from '@deployhealth/core';

/** The demo incident's deploy (acme-storefront's last deploy in the seed). */
export const LANDING_DEPLOY_SHA = 'b52952e8192c38c054e53b5447ea20de88f2e2e9';

/**
 * The landing page's example alert, built by the same function that writes real alerts, with the
 * demo incident's values: "Acme API started failing 4m after deploy b52952e, which introduced
 * 2 missing env vars: REDIS_URL, STRIPE_KEY". The seed's own alert reads the same (packages/db).
 */
export function landingAlertMessage(): string {
  const deployedAt = new Date(0);
  return alertOpenedMessage({
    endpoint: { name: 'Acme API', url: 'https://api.acme.example/' },
    deploy: { sha: LANDING_DEPLOY_SHA, deployedAt },
    firstFailureAt: new Date(deployedAt.getTime() + 4 * 60_000),
    newMissing: ['REDIS_URL', 'STRIPE_KEY'],
  });
}

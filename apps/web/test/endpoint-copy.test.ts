import { CHECK_TIMEOUT_MS, HOST_CHECK_SPACING_MS, MAX_CHECKS_PER_HOST_PER_CLAIM, MAX_REDIRECTS } from '@deployhealth/core';
import type { EndpointMonitoring } from '@deployhealth/db';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/projects/[projectId]/endpoint-actions', () => ({ saveEndpointAction: async () => ({ status: 'idle' }), deleteEndpointAction: async () => {} }));
vi.mock('@/components/latency-chart', () => ({ LatencyChart: () => null }));

const { EndpointForm, INTERVAL_HINT, URL_HINT } = await import('@/app/projects/[projectId]/endpoint-form');
const { EndpointsSection } = await import('@/components/endpoints-section');

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the endpoint form says how checks run, from the constants', () => {
  const html = renderToStaticMarkup(
    createElement(EndpointForm, {
      action: async () => ({ status: 'idle' as const }),
      initial: { name: '', url: '', method: 'GET', intervalSeconds: '60', expectedStatus: '200', enabled: true },
      submitLabel: 'Add endpoint',
    }),
  );

  it('under Interval: per-host spacing and the 5-endpoint limit', () => {
    expect(INTERVAL_HINT).toBe(
      'Checks of one host are spaced 10 seconds apart, so more than 5 endpoints on the same host at this interval are checked less often.',
    );
    expect(INTERVAL_HINT).toContain(`spaced ${HOST_CHECK_SPACING_MS / 1000} seconds apart, so more than ${MAX_CHECKS_PER_HOST_PER_CLAIM} endpoints`);
    expect(plain(html)).toContain(INTERVAL_HINT);
  });

  it('under URL: the timeout, redirects and status rule', () => {
    expect(URL_HINT).toBe('10-second timeout; up to 5 redirects; the final status must equal the expected status.');
    expect(URL_HINT).toContain(`${CHECK_TIMEOUT_MS / 1000}-second timeout; up to ${MAX_REDIRECTS} redirects`);
    expect(plain(html)).toContain(URL_HINT);
  });
});

describe("the endpoint card's failures in 24h", () => {
  const monitoring = (failures24h: number): EndpointMonitoring => ({
    endpoint: {
      id: 'e1',
      projectId: 'p1',
      url: 'https://api.acme.example/health',
      name: 'Acme API',
      method: 'GET',
      intervalSeconds: 60,
      expectedStatus: 200,
      enabled: true,
      nextCheckAt: new Date(),
      consecutiveFailures: 0,
      consecutiveOk: 3,
      createdAt: new Date(),
    },
    status: 'up',
    uptime24h: 0.98,
    uptime7d: 0.99,
    failures24h,
    latency: [],
    recent: [],
    openAlert: null,
    failingSince: null,
  });
  const render = (failures24h: number) =>
    renderToStaticMarkup(createElement(EndpointsSection, { projectId: 'p1', endpoints: [monitoring(failures24h)], readOnly: true }));

  it('shows "31 failures in 24h" and "1 failure in 24h" in the stats row', () => {
    expect(render(31)).toMatch(/data-testid="failures-24h"[^>]*>31 failures in 24h</);
    expect(render(1)).toMatch(/data-testid="failures-24h"[^>]*>1 failure in 24h</);
  });

  it('shows nothing with no failures', () => {
    expect(render(0)).not.toContain('failures-24h');
    expect(render(0)).not.toMatch(/in 24h/);
  });
});

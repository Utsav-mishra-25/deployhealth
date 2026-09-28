import { describe, expect, it } from 'vitest';
import { clientFormSchema, endpointFormSchema, endpointFormValues } from '@/lib/validation';

describe('clientFormSchema', () => {
  it('trims and turns empty optional fields into null', () => {
    expect(clientFormSchema.parse({ name: '  Acme ', contactEmail: '', notes: '  ' })).toEqual({ name: 'Acme', contactEmail: null, notes: null });
  });

  it('rejects a blank name and a bad email', () => {
    const result = clientFormSchema.safeParse({ name: ' ', contactEmail: 'not-an-email', notes: '' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path[0]).sort()).toEqual(['contactEmail', 'name']);
  });
});

describe('endpointFormSchema', () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(entries)) data.set(k, v);
    return endpointFormValues(data);
  };

  it('parses a submitted form, including the checkbox and numeric fields', () => {
    const values = form({ url: ' https://api.acme.com/health ', method: 'HEAD', intervalSeconds: '900', expectedStatus: '204', enabled: 'on' });
    expect(endpointFormSchema.parse(values)).toEqual({
      url: 'https://api.acme.com/health',
      method: 'HEAD',
      intervalSeconds: 900,
      expectedStatus: 204,
      enabled: true,
    });
    expect(endpointFormSchema.parse(form({ url: 'https://x.dev', method: 'GET', intervalSeconds: '60', expectedStatus: '200' })).enabled).toBe(false);
  });

  it.each([
    ['interval not in 60/300/900', { intervalSeconds: '120' }],
    ['POST method', { method: 'POST' }],
    ['status out of range', { expectedStatus: '700' }],
    ['fractional status', { expectedStatus: '200.5' }],
    ['empty url', { url: '' }],
  ])('rejects %s', (_label, override) => {
    const base = { url: 'https://x.dev', method: 'GET', intervalSeconds: '300', expectedStatus: '200', enabled: 'on' };
    expect(endpointFormSchema.safeParse(form({ ...base, ...override })).success).toBe(false);
  });
});

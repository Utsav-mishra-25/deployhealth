import { ENDPOINT_INTERVALS, ENDPOINT_METHODS, type EndpointInterval } from '@deployhealth/core/browser';
import { z } from 'zod';

/** First error message per field, for forms. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? 'form');
    out[key] ??= issue.message;
  }
  return out;
}

export const text = (form: FormData, name: string) => String(form.get(name) ?? '');

export const clientFormSchema = z.object({
  name: z.string().trim().min(1, 'Give the client a name').max(80, 'Keep it under 80 characters'),
  contactEmail: z
    .union([z.literal(''), z.email('Enter a valid email address')])
    .transform((v) => v || null),
  notes: z
    .string()
    .trim()
    .max(2000, 'Keep notes under 2000 characters')
    .transform((v) => v || null),
});

export const endpointFormSchema = z.object({
  /** Optional display name; blank means "use the host". */
  name: z
    .string()
    .trim()
    .max(60, 'Use at most 60 characters')
    .transform((v) => v || null),
  url: z.string().trim().min(1, 'Enter a URL').max(2000, 'That URL is too long'),
  method: z.enum(ENDPOINT_METHODS),
  intervalSeconds: z.coerce
    .number()
    .refine((n): n is EndpointInterval => (ENDPOINT_INTERVALS as readonly number[]).includes(n), 'Pick an interval')
    .transform((n) => n as EndpointInterval),
  expectedStatus: z.coerce.number().int('Use a whole number').min(100, 'Use 100–599').max(599, 'Use 100–599'),
  enabled: z.boolean(),
});

export function endpointFormValues(form: FormData) {
  return {
    name: text(form, 'name'),
    url: text(form, 'url'),
    method: text(form, 'method'),
    intervalSeconds: text(form, 'intervalSeconds'),
    expectedStatus: text(form, 'expectedStatus'),
    enabled: form.get('enabled') === 'on',
  };
}

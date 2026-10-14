import { ENDPOINT_SAVE_WINDOW_MS, ENDPOINT_SAVES_PER_WINDOW } from '@deployhealth/core';
import { createRateLimiter } from '@/lib/rate-limit';

// Every save resolves the URL's host (assertPublicUrl), so saves are limited per user. In memory,
// per web process, like the other limits in lib/rate-limit.ts.
const saves = createRateLimiter({ limit: ENDPOINT_SAVES_PER_WINDOW, windowMs: ENDPOINT_SAVE_WINDOW_MS });

/** Counts one endpoint save (create or edit) for the user; a message to show once over the limit, else null. */
export function endpointSaveRefusal(userId: string): string | null {
  const { ok, retryAfterSeconds } = saves.check(userId);
  if (ok) return null;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many endpoint saves: at most ${ENDPOINT_SAVES_PER_WINDOW} every ${ENDPOINT_SAVE_WINDOW_MS / 60_000} minutes. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

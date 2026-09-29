/**
 * A fixed-window rate limiter kept in memory: per process, reset on restart. Enough for one web
 * instance guarding a low-traffic public route; several instances would each count separately.
 */
export function createRateLimiter({ limit, windowMs, now = Date.now }: { limit: number; windowMs: number; now?: () => number }) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key: string): { ok: boolean; remaining: number; retryAfterSeconds: number } {
      const t = now();
      // Keep memory bounded: drop finished windows once the map gets large.
      if (windows.size > 10_000) for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      let window = windows.get(key);
      if (!window || window.resetAt <= t) {
        window = { count: 0, resetAt: t + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      const ok = window.count <= limit;
      return { ok, remaining: Math.max(0, limit - window.count), retryAfterSeconds: ok ? 0 : Math.ceil((window.resetAt - t) / 1000) };
    },
  };
}

/**
 * The client's IP as seen by the proxy in front of the app: the LAST X-Forwarded-For entry, which
 * that proxy appended. Earlier entries come from the client and can be forged to dodge a limit.
 * (Behind more than one proxy, this would need to skip the extra hops.)
 */
export function clientIp(headers: Headers): string {
  const hops = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? 'unknown';
}

/**
 * Fixed-window rate limiter, in memory. Correct for a single instance; swap the store for
 * Postgres or Redis before running more than one API instance.
 */
import type { Context, MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  key: (c: Context) => string;
}

export function rateLimit({ windowMs, max, key }: RateLimitOptions): MiddlewareHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = 0;
  return async (c, next) => {
    const now = Date.now();
    if (now - lastSweep > windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const k = key(c);
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count++;
    c.header("ratelimit-limit", String(max));
    c.header("ratelimit-remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      c.header("retry-after", String(Math.ceil((entry.resetAt - now) / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    await next();
  };
}

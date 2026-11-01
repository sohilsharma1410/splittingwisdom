import type { Request, Response, NextFunction } from "express";

interface LimitOptions {
  max: number;
  windowMs: number;
  message?: string;
}

/**
 * Minimal in-memory sliding-window limiter. Fine for a single instance
 * serving a small friend circle — not meant to survive multiple instances
 * or a restart.
 */
function slidingWindowLimiter(options: LimitOptions, keyFor: (req: Request) => string | null) {
  const hits = new Map<string, number[]>();

  // Keys here can be attacker-chosen (IP/email), so stale ones must be
  // swept or the map grows without bound.
  setInterval(() => {
    const cutoff = Date.now() - options.windowMs;
    for (const [key, stamps] of hits) {
      if (stamps.every((t) => t <= cutoff)) hits.delete(key);
    }
  }, 60_000).unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFor(req);
    if (key === null) {
      next();
      return;
    }
    const now = Date.now();
    const windowStart = now - options.windowMs;

    const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= options.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + options.windowMs - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ error: { message: options.message ?? "Too many requests. Try again in a minute." } });
      return;
    }

    timestamps.push(now);
    hits.set(key, timestamps);
    next();
  };
}

/** Limits per logged-in user (requireAuth must run first). */
export function rateLimit(options: LimitOptions) {
  return slidingWindowLimiter(options, (req) => `u:${req.session.userId!}`);
}

/**
 * The client's real address. Behind Vercel's /api rewrite, Express's own
 * `req.ip` is Vercel's egress address for every user, so use the first
 * X-Forwarded-For entry (which Vercel sets to the client) and fall back to
 * req.ip when there's no proxy.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first || req.ip || "unknown";
}

/** Limits unauthenticated routes per client IP. */
export function rateLimitByIp(options: LimitOptions) {
  return slidingWindowLimiter(options, (req) => `ip:${clientIp(req)}`);
}

/**
 * Limits per client IP + target email, so one attacker can't grind a single
 * account's password but a wrong guess from one person doesn't lock others out.
 */
export function rateLimitByIpAndEmail(options: LimitOptions) {
  return slidingWindowLimiter(options, (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    return `ip+email:${clientIp(req)}|${email}`;
  });
}

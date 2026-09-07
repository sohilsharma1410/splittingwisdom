import type { Request, Response, NextFunction } from "express";

/**
 * A minimal in-memory sliding-window limiter, keyed by session user id.
 * Fine for a single Render instance serving a small friend circle — not
 * meant to survive multiple server instances or a restart.
 */
export function rateLimit(options: { max: number; windowMs: number }) {
  const hits = new Map<number, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const userId = req.session.userId!;
    const now = Date.now();
    const windowStart = now - options.windowMs;

    const timestamps = (hits.get(userId) ?? []).filter((t) => t > windowStart);
    if (timestamps.length >= options.max) {
      res.status(429).json({ error: { message: "Too many requests. Try again in a minute." } });
      return;
    }

    timestamps.push(now);
    hits.set(userId, timestamps);
    next();
  };
}

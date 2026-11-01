import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { RoleGuard } from "../roles/guard.js";

/**
 * Plan P3.4 / S3.3. Mount once at `app.use("/api", requireWritable(guard))`,
 * before the routers. Blocks every mutating request (POST/PUT/PATCH/DELETE)
 * with 503 while this node is not the active primary; reads always pass.
 * With no APP_ROLE configured the guard says "writable" and this is a no-op,
 * so single-node deployments behave exactly as before.
 *
 * Exempt: sign-in/sign-out. They only touch this node's own session rows (not
 * replicated business data), and a read-only node should still let people log
 * in to look at their balances.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

export const READ_ONLY_MESSAGE = "Read-only: backup mode switching";

function fullPath(req: Request): string {
  return (req.baseUrl + req.path).replace(/\/+$/, "") || "/";
}

export function requireWritable(guard: RoleGuard): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method) || EXEMPT_PATHS.has(fullPath(req))) {
      next();
      return;
    }
    const verdict = await guard.check(); // never throws
    if (verdict.writable) {
      next();
      return;
    }
    res.set("Retry-After", "5");
    res.status(503).json({ error: { message: READ_ONLY_MESSAGE } });
  };
}

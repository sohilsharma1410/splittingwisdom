import { Router } from "express";
import type { RoleGuard } from "../roles/guard.js";

export interface SyncInfo {
  lastSyncAt: Date | null;
  lagSeconds: number | null;
}

/**
 * GET /api/health/role  ->  { data: { role, active, activePrimary, epoch, writable, lastSyncAt, lagSeconds } }
 *
 * Public and cheap (no auth, one cached role read): the controller, the
 * PWA's failover logic and uptime pingers call it. Nothing sensitive in it.
 *
 *   role           "primary" | "standby" | "standalone" (APP_ROLE unset)
 *   active         this node is currently the one allowed to write
 *   activePrimary  who system_state says is primary: "pi" | "standby" | "cutover" (null if unknown)
 *   epoch          fencing counter (null if unknown)
 *   lastSyncAt     last time the Pi's changes were confirmed copied to the standby
 *   lagSeconds     age of the oldest change not yet copied (null if unknown)
 *
 * `getSyncInfo` is injected: on the Pi it reads the local outbox, on the
 * standby it reads the heartbeat row the Pi writes.
 */
export function createHealthRouter(deps: { guard: RoleGuard; getSyncInfo: () => Promise<SyncInfo> }): Router {
  const router = Router();

  router.get("/role", async (_req, res) => {
    const verdict = await deps.guard.check();
    let sync: SyncInfo = { lastSyncAt: null, lagSeconds: null };
    try {
      sync = await deps.getSyncInfo();
    } catch {
      // sync info is best-effort; role information is the point of this endpoint
    }
    res.json({
      data: {
        role: verdict.role ?? "standalone",
        active: verdict.writable,
        activePrimary: verdict.activePrimary,
        epoch: verdict.epoch,
        writable: verdict.writable,
        lastSyncAt: sync.lastSyncAt ? sync.lastSyncAt.toISOString() : null,
        lagSeconds: sync.lagSeconds,
      },
    });
  });

  return router;
}

import type { Express } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { makeSql, type Sql } from "../sync/client.js";
import { logEvent, errorMessage } from "../sync/log.js";
import { loadRoleConfig, type RoleConfig } from "./config.js";
import { RoleGuard } from "./guard.js";
import { readSystemState, readHeartbeat, writeHeartbeat } from "./state-store.js";
import { requireWritable } from "../middleware/require-writable.js";
import { createHealthRouter, type SyncInfo } from "../routes/health.js";
import { Controller, makeHttpProbe } from "../controller/controller.js";

export interface RoleRuntime {
  guard: RoleGuard;
  config: RoleConfig;
  stop(): Promise<void>;
}

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));

/** Pi side: sync position from the local outbox/sync_status (written by the sync agent). Throws if the local DB is down. */
async function localSyncInfo(): Promise<SyncInfo> {
  const rows = await db.execute<{ lag: number; last_success_at: unknown }>(sql`
    SELECT COALESCE((SELECT EXTRACT(EPOCH FROM (clock_timestamp() - min("at")))
                     FROM sync_outbox WHERE sent_at IS NULL), 0)::float8 AS lag,
           (SELECT last_success_at FROM sync_status WHERE id = 1) AS last_success_at`);
  const row = rows[0];
  return { lagSeconds: Math.round(Number(row.lag) * 10) / 10, lastSyncAt: toDate(row.last_success_at) };
}

/**
 * One call wires plan workstream S3 into the Express app (see index.ts):
 *   - GET /api/health/role
 *   - requireWritable on every mutating /api route (503 while not the active primary)
 *   - Pi: heartbeat into the standby DB
 *   - Render: the failover controller (CONTROLLER_ENABLED=true)
 *
 * With APP_ROLE unset it only adds /api/health/role ("standalone") and a
 * requireWritable that always passes: today's single-node behaviour.
 */
export function installRoleFencing(app: Express, env: NodeJS.ProcessEnv = process.env): RoleRuntime {
  const config = loadRoleConfig(env);
  const stoppers: Array<() => void | Promise<void>> = [];

  let authority: Sql | null = null;
  if (config.role) {
    if (!config.authorityUrl) {
      throw new Error("APP_ROLE is set but no authority database is configured (ROLE_STATE_DATABASE_URL / DATABASE_URL).");
    }
    authority = makeSql(config.authorityUrl, config.authoritySsl, 2);
    stoppers.push(() => authority!.end({ timeout: 5 }));
  }

  const guard = new RoleGuard({
    role: config.role,
    readState: () => readSystemState(authority!),
    cacheMs: config.cacheMs,
    staleGraceMs: config.staleGraceMs,
  });

  const getSyncInfo = async (): Promise<SyncInfo> => {
    if (config.role === "primary") return localSyncInfo();
    if (config.role === "standby" && authority) {
      const beat = await readHeartbeat(authority, "pi");
      return { lastSyncAt: beat?.lastSyncAt ?? null, lagSeconds: beat?.lagSeconds ?? null };
    }
    return { lastSyncAt: null, lagSeconds: null };
  };

  app.use("/api/health", createHealthRouter({ guard, getSyncInfo }));
  app.use("/api", requireWritable(guard));

  if (config.role === "primary" && authority) {
    stoppers.push(startHeartbeat(authority, config.heartbeatMs, localSyncInfo));
  }

  if (config.controllerEnabled) {
    if (config.role !== "standby" || !authority || !config.piPublicUrl) {
      throw new Error("CONTROLLER_ENABLED requires APP_ROLE=standby and PI_PUBLIC_URL.");
    }
    const controller = new Controller(config, {
      authority,
      probePi: makeHttpProbe(config.piPublicUrl, config.probeTimeoutMs),
    });
    controller.start();
    stoppers.push(() => controller.stop());
    logEvent("info", "controller_started", { probeIntervalMs: config.probeIntervalMs });
  }

  return {
    guard,
    config,
    stop: async () => {
      for (const stopFn of stoppers.reverse()) await stopFn();
    },
  };
}

/** Pi API process: proves "API + local DB are alive" to the standby every `intervalMs`. */
export function startHeartbeat(authority: Sql, intervalMs: number, localInfo: () => Promise<SyncInfo>): () => void {
  let warned = false;
  const beat = async () => {
    try {
      const info = await localInfo(); // throws when the local DB is down: then we must NOT beat
      await writeHeartbeat(authority, "pi", info);
      warned = false;
    } catch (err) {
      if (!warned) logEvent("warn", "heartbeat_failed", { error: errorMessage(err) });
      warned = true;
    }
  };
  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

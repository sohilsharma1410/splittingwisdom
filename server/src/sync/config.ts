export interface SyncConfig {
  sourceUrl: string;
  /** TLS to the source DB (Pi local Postgres: off). */
  sourceSsl: boolean;
  targetUrl: string;
  /** TLS to the target DB (Supabase: on). */
  targetSsl: boolean;
  /** Max outbox events applied per target transaction. */
  batchSize: number;
  /** Idle poll interval. */
  pollMs: number;
  /** Interval for the (snapshot-style) session table mirror. 0 disables. */
  sessionSyncMs: number;
  /** Sent outbox rows older than this are deleted. */
  purgeSentAfterMinutes: number;
  /** When idle, how often the "last successful sync" heartbeat is written. */
  heartbeatMs: number;
  /** Optional Supabase REST keep-alive ping (plan S1.6). */
  supabase?: { url: string; anonKey: string; pingIntervalMs: number };
}

function parseOnOff(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  throw new Error(`${name} must be "on" or "off" (got "${raw}").`);
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number, allowZero = false): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer (got "${raw}").`);
  }
  return n;
}

/**
 * Reads the agent configuration from the environment.
 *
 *   SYNC_SOURCE_DATABASE_URL   default: DATABASE_URL (the Pi's local Postgres)
 *   SYNC_SOURCE_SSL            on|off, default: DATABASE_SSL, else off
 *   SYNC_TARGET_DATABASE_URL   required (Supabase pooler URL)
 *   SYNC_TARGET_SSL            on|off, default on
 *   SYNC_BATCH_SIZE            default 500
 *   SYNC_POLL_MS               default 1000
 *   SYNC_SESSION_SYNC_MS       default 30000 (0 = off)
 *   SYNC_PURGE_SENT_MINUTES    default 60
 *   SYNC_HEARTBEAT_MS          default 30000
 *   SUPABASE_URL + SUPABASE_ANON_KEY  -> enables the 6 h REST ping
 *   SUPABASE_PING_INTERVAL_MS  default 21600000 (6 h)
 */
export function loadSyncConfig(env: NodeJS.ProcessEnv = process.env): SyncConfig {
  const sourceUrl = env.SYNC_SOURCE_DATABASE_URL || env.DATABASE_URL;
  if (!sourceUrl) {
    throw new Error("Set SYNC_SOURCE_DATABASE_URL (or DATABASE_URL) to the primary database.");
  }
  const targetUrl = env.SYNC_TARGET_DATABASE_URL;
  if (!targetUrl) {
    throw new Error("SYNC_TARGET_DATABASE_URL is not set (the standby Postgres to copy changes into).");
  }
  if (sourceUrl === targetUrl) {
    throw new Error("SYNC_TARGET_DATABASE_URL must differ from the source database URL.");
  }

  const supabaseUrl = env.SUPABASE_URL;
  const anonKey = env.SUPABASE_ANON_KEY;

  return {
    sourceUrl,
    sourceSsl: parseOnOff("SYNC_SOURCE_SSL", env.SYNC_SOURCE_SSL ?? env.DATABASE_SSL, false),
    targetUrl,
    targetSsl: parseOnOff("SYNC_TARGET_SSL", env.SYNC_TARGET_SSL, true),
    batchSize: parsePositiveInt("SYNC_BATCH_SIZE", env.SYNC_BATCH_SIZE, 500),
    pollMs: parsePositiveInt("SYNC_POLL_MS", env.SYNC_POLL_MS, 1000),
    sessionSyncMs: parsePositiveInt("SYNC_SESSION_SYNC_MS", env.SYNC_SESSION_SYNC_MS, 30_000, true),
    purgeSentAfterMinutes: parsePositiveInt("SYNC_PURGE_SENT_MINUTES", env.SYNC_PURGE_SENT_MINUTES, 60),
    heartbeatMs: parsePositiveInt("SYNC_HEARTBEAT_MS", env.SYNC_HEARTBEAT_MS, 30_000),
    supabase:
      supabaseUrl && anonKey
        ? {
            url: supabaseUrl.replace(/\/+$/, ""),
            anonKey,
            pingIntervalMs: parsePositiveInt("SUPABASE_PING_INTERVAL_MS", env.SUPABASE_PING_INTERVAL_MS, 6 * 60 * 60 * 1000),
          }
        : undefined,
  };
}

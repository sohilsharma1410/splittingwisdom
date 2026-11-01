export type AppRole = "primary" | "standby";

export interface RoleConfig {
  /** undefined = single-node deployment: no fencing, everything writable (today's behaviour). */
  role: AppRole | undefined;
  /** Database holding the authoritative system_state (the standby/Supabase DB). */
  authorityUrl: string | undefined;
  authoritySsl: boolean;
  /** How long a role verdict is reused before re-reading system_state. */
  cacheMs: number;
  /** If the authority is unreachable, a previously read verdict stays valid this long. */
  staleGraceMs: number;
  /** Pi API -> standby DB liveness write interval. */
  heartbeatMs: number;
  controllerEnabled: boolean;
  piPublicUrl: string | undefined;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  /** A heartbeat older than this counts as "Pi not beating". */
  heartbeatStaleMs: number;
  failThreshold: number;
  healthyThreshold: number;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  throw new Error(`Expected on/off for a boolean env var, got "${raw}".`);
}

function seconds(name: string, raw: string | undefined, fallbackSeconds: number): number {
  if (raw === undefined || raw === "") return fallbackSeconds * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of seconds (got "${raw}").`);
  return Math.round(n * 1000);
}

function count(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer (got "${raw}").`);
  return n;
}

/**
 *   APP_ROLE                        primary | standby   (unset = no fencing)
 *   ROLE_STATE_DATABASE_URL         default: primary -> SYNC_TARGET_DATABASE_URL, standby -> DATABASE_URL
 *   ROLE_STATE_SSL                  on|off, default on (off if the chosen URL is DATABASE_URL and DATABASE_SSL=off)
 *   ROLE_CACHE_SECONDS              default 10
 *   ROLE_STALE_GRACE_SECONDS        default 600
 *   HEARTBEAT_INTERVAL_SECONDS      default 15
 *   CONTROLLER_ENABLED              default false (Render standby: true)
 *   PI_PUBLIC_URL                   the Pi's Funnel URL, probed by the controller
 *   CONTROLLER_PROBE_INTERVAL_SECONDS (30)  CONTROLLER_PROBE_TIMEOUT_SECONDS (5)
 *   CONTROLLER_FAIL_THRESHOLD (3)   CONTROLLER_HEALTHY_THRESHOLD (5)
 */
export function loadRoleConfig(env: NodeJS.ProcessEnv = process.env): RoleConfig {
  const rawRole = env.APP_ROLE?.trim().toLowerCase();
  if (rawRole && rawRole !== "primary" && rawRole !== "standby") {
    throw new Error(`APP_ROLE must be "primary" or "standby" (got "${env.APP_ROLE}").`);
  }
  const role = (rawRole || undefined) as AppRole | undefined;

  const explicit = env.ROLE_STATE_DATABASE_URL || undefined;
  const authorityUrl =
    explicit ?? (role === "primary" ? env.SYNC_TARGET_DATABASE_URL || env.DATABASE_URL : env.DATABASE_URL) ?? undefined;
  const usingOwnDb = !explicit && authorityUrl === env.DATABASE_URL;
  const authoritySsl = flag(
    env.ROLE_STATE_SSL,
    usingOwnDb ? flag(env.DATABASE_SSL, true) : flag(env.SYNC_TARGET_SSL, true),
  );

  const probeIntervalMs = seconds("CONTROLLER_PROBE_INTERVAL_SECONDS", env.CONTROLLER_PROBE_INTERVAL_SECONDS, 30);
  const heartbeatMs = seconds("HEARTBEAT_INTERVAL_SECONDS", env.HEARTBEAT_INTERVAL_SECONDS, 15);

  return {
    role,
    authorityUrl,
    authoritySsl,
    cacheMs: seconds("ROLE_CACHE_SECONDS", env.ROLE_CACHE_SECONDS, 10),
    staleGraceMs: seconds("ROLE_STALE_GRACE_SECONDS", env.ROLE_STALE_GRACE_SECONDS, 600),
    heartbeatMs,
    controllerEnabled: flag(env.CONTROLLER_ENABLED, false),
    piPublicUrl: env.PI_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
    probeIntervalMs,
    probeTimeoutMs: seconds("CONTROLLER_PROBE_TIMEOUT_SECONDS", env.CONTROLLER_PROBE_TIMEOUT_SECONDS, 5),
    heartbeatStaleMs: heartbeatMs * 3,
    failThreshold: count("CONTROLLER_FAIL_THRESHOLD", env.CONTROLLER_FAIL_THRESHOLD, 3),
    healthyThreshold: count("CONTROLLER_HEALTHY_THRESHOLD", env.CONTROLLER_HEALTHY_THRESHOLD, 5),
  };
}

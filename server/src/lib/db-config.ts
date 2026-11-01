/**
 * How this node talks to its own Postgres (plan P3.1). Both defaults match the
 * Render + Supabase deployment, so it needs no new env vars:
 *
 *   DATABASE_SSL     on|off, default on.  The Pi's container network has no TLS: off.
 *   DATABASE_POOLER  on|off, default on.  Transaction poolers (Supabase) can't use
 *                    prepared statements; the Pi connects directly: off.
 */
function onOff(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  throw new Error(`${name} must be "on" or "off" (got "${raw}").`);
}

export function databaseSslEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onOff("DATABASE_SSL", env.DATABASE_SSL, true);
}

export function databaseUsesPooler(env: NodeJS.ProcessEnv = process.env): boolean {
  return onOff("DATABASE_POOLER", env.DATABASE_POOLER, true);
}

/** Encrypted without certificate pinning: Supabase's pooler doesn't chain to a public CA. */
export const INSECURE_TLS = { rejectUnauthorized: false } as const;

/** Connection options for a postgres.js client on this node's own database. */
export function postgresJsOptions(env: NodeJS.ProcessEnv = process.env) {
  return {
    prepare: !databaseUsesPooler(env),
    // Timestamps are stored without a timezone and read back as UTC, so every session must write
    // UTC too. Otherwise a database running in local time (a laptop in India) stores 21:05 IST, which
    // reads back as 21:05 UTC and shows as "tomorrow". Not sent through Supabase's pooler, which can
    // reject extra startup parameters and already runs in UTC.
    ...(databaseUsesPooler(env) ? {} : { connection: { TimeZone: "UTC" } }),
    ...(databaseSslEnabled(env) ? { ssl: INSECURE_TLS } : {}),
  };
}

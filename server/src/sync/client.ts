import postgres from "postgres";

export type Sql = postgres.Sql;

/**
 * A postgres.js client for the sync tools. TLS "on" means encrypted without
 * certificate pinning, the same trade-off server/src/session.ts already makes
 * for Supabase's pooler; "off" leaves any `sslmode=` in the URL in charge.
 * Prepared statements are off so the target may sit behind a transaction
 * pooler (Supavisor / pgbouncer).
 */
export function makeSql(url: string, ssl: boolean, max = 2): Sql {
  return postgres(url, {
    max,
    prepare: false,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    connect_timeout: 15,
    idle_timeout: 60,
    max_lifetime: 60 * 30,
    onnotice: () => undefined,
  });
}

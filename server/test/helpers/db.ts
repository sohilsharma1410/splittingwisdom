import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { assertLocalDatabaseUrl } from "./env.js";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** The synced application tables (parents first). */
export const APP_TABLES = [
  "users",
  "groups",
  "group_members",
  "bills",
  "bill_items",
  "item_assignments",
  "settlements",
] as const;

export function connect(url: string, max = 4) {
  assertLocalDatabaseUrl("database url", url);
  return postgres(url, { max, onnotice: () => undefined, connection: { TimeZone: "UTC" } });
}

/** Drops everything and re-applies every migration. Local clusters only. */
export async function resetAndMigrate(url: string): Promise<void> {
  const sql = connect(url, 1);
  try {
    // The standby tag is a database-level setting (survives schema drops): clear it.
    await sql.unsafe(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I RESET sw.origin', current_database()); END $$`);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await sql.unsafe("CREATE SCHEMA public");
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await sql.end();
  }
}

/** Empties every table the app and the sync machinery own and restarts ids. */
export async function truncateAll(sql: postgres.Sql): Promise<void> {
  const rows = await sql<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  `;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  // Re-seed the singleton rows the migrations insert.
  await sql.unsafe(`
    DO $$ BEGIN
      IF to_regclass('public.sync_status') IS NOT NULL THEN
        INSERT INTO sync_status (id) VALUES (1) ON CONFLICT DO NOTHING;
      END IF;
      IF to_regclass('public.system_state') IS NOT NULL THEN
        INSERT INTO system_state (id, active_primary, epoch) VALUES (1, 'pi', 1) ON CONFLICT DO NOTHING;
      END IF;
    END $$`);
}

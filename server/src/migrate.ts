import "dotenv/config";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { postgresJsOptions } from "./lib/db-config.js";
import { errorMessage, logEvent } from "./sync/log.js";

/**
 * Applies pending migrations from server/drizzle, for production images that
 * don't ship drizzle-kit (a dev dependency). It uses the same journal table as
 * `npm run db:migrate`, so the two can be mixed, and is safe to run at every start.
 */
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set.");
}

const client = postgres(connectionString, { ...postgresJsOptions(), max: 1, onnotice: () => undefined });

try {
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  logEvent("info", "migrations_applied");
} catch (err) {
  logEvent("error", "migrations_failed", { error: errorMessage(err) });
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}

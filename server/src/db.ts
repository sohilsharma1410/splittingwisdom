import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@splittingwisdom/shared";
import { postgresJsOptions } from "./lib/db-config.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy server/.env.example to server/.env and fill it in.");
}

const client = postgres(connectionString, postgresJsOptions());
export const db = drizzle(client, { schema });

/** Graceful shutdown: lets running queries finish, then closes the pool. */
export function closeDb(): Promise<void> {
  return client.end({ timeout: 5 });
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@splittingwisdom/shared";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. Copy server/.env.example to server/.env and fill it in.");
}

const client = postgres(connectionString, { prepare: false });
export const db = drizzle(client, { schema });

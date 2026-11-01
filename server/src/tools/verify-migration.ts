import "dotenv/config";
import { makeSql } from "../sync/client.js";
import { databaseSslEnabled } from "../lib/db-config.js";
import { formatReport, verifyPair } from "../sync/integrity.js";

/**
 * QA-4 for the Supabase -> Pi migration (plan P4): compares this node's database
 * with the database it was restored from. Read-only on both sides.
 *
 * `updated_at` and `origin` are left out of the row comparison. A restore stamps
 * them on the Pi, and the source may not have those columns yet (migration 0005).
 *
 *   MIGRATION_SOURCE_URL   the Supabase session pooler URL
 *   DATABASE_URL           this node's database
 */
const sourceUrl = process.env.MIGRATION_SOURCE_URL;
const targetUrl = process.env.DATABASE_URL;
if (!sourceUrl || !targetUrl) {
  console.error("MIGRATION_SOURCE_URL and DATABASE_URL must both be set.");
  process.exit(2);
}

const target = makeSql(targetUrl, databaseSslEnabled(), 2);
const source = makeSql(sourceUrl, process.env.MIGRATION_SOURCE_SSL !== "off", 2);

try {
  const report = await verifyPair(target, source, {
    ignoreColumns: ["updated_at", "origin"],
    otherNode: "pi",
  });
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} catch (err) {
  // Only the message: a driver error object can carry the connection details.
  console.error(`verify-migration failed to run: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exitCode = 2;
} finally {
  await Promise.allSettled([target.end({ timeout: 5 }), source.end({ timeout: 5 })]);
}

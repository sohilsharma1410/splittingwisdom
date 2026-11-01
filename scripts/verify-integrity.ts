/**
 * QA-4 data-integrity check (plan §7.3).
 *
 *   one database:   per-table row counts, foreign-key orphans, per-bill
 *                   "sum of shares = total" in exact paise (shared balance
 *                   engine), and "every id sequence is above max(id)" for the
 *                   node's own id range.
 *   two databases:  all of the above on both, plus row counts equal, rows
 *                   identical in every column, and per-pair balances equal.
 *
 * Usage (from the repo root; build the shared package first):
 *   npm run build --workspace=shared
 *   npm run verify:integrity --workspace=server -- <primary-url> [<other-url>] [--primary-ssl on|off] [--other-ssl on|off] [--other-node pi|standby] [--json]
 *
 * URLs may also come from INTEGRITY_PRIMARY_URL / INTEGRITY_OTHER_URL (keeps
 * passwords out of shell history). SSL defaults to off for the primary (the
 * Pi's local Postgres) and on for the other (Supabase). Read-only: it only runs
 * SELECTs. Exit code 0 = all checks passed, 1 = a check failed, 2 = bad usage.
 */
import { makeSql } from "../server/src/sync/client.js";
import { verifyDatabase, verifyPair, formatReport } from "../server/src/sync/integrity.js";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const onOff = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v.toLowerCase() === "on");

async function main() {
  const args = process.argv.slice(2);
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") continue;
    if (args[i].startsWith("--")) i++; // skip the option's value
    else positional.push(args[i]);
  }
  const primaryUrl = positional[0] ?? process.env.INTEGRITY_PRIMARY_URL;
  const otherUrl = positional[1] ?? process.env.INTEGRITY_OTHER_URL;
  if (!primaryUrl) {
    console.error("usage: verify-integrity <primary-url> [<other-url>] [--primary-ssl on|off] [--other-ssl on|off] [--other-node pi|standby] [--json]");
    process.exit(2);
  }

  const primary = makeSql(primaryUrl, onOff(option(args, "--primary-ssl"), false), 2);
  const other = otherUrl ? makeSql(otherUrl, onOff(option(args, "--other-ssl"), true), 2) : undefined;
  try {
    const otherNode = option(args, "--other-node") as "pi" | "standby" | undefined;
    const report = other ? await verifyPair(primary, other, { otherNode }) : await verifyDatabase(primary);
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await Promise.allSettled([primary.end({ timeout: 5 }), other?.end({ timeout: 5 })]);
  }
}

main().catch((err) => {
  console.error(`verify-integrity failed to run: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});

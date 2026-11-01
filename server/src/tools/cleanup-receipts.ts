import "dotenv/config";
import { count } from "drizzle-orm";
import { bills } from "@splittingwisdom/shared";
import { closeDb, db } from "../db.js";
import { deleteReceiptImage, listReceiptImagePaths } from "../lib/storage.js";
import { planCleanup } from "../lib/receipt-cleanup.js";

/**
 * Deletes photos from abandoned scans (plan D3.7). Only reports unless given --delete.
 * Works with either storage driver. On the Pi, a weekly timer runs it.
 *
 *   node server/dist/tools/cleanup-receipts.js            shows what it would delete
 *   node server/dist/tools/cleanup-receipts.js --delete   deletes them
 *   add --force                                           allows a large delete it refused
 *
 * Exit codes: 0 fine, 1 failed, 3 refused because something looked wrong.
 */
async function main(): Promise<number> {
  const apply = process.argv.includes("--delete");
  const force = process.argv.includes("--force");

  const [files, referenced, [{ total }]] = await Promise.all([
    listReceiptImagePaths(),
    db.select({ path: bills.receiptImageUrl }).from(bills),
    db.select({ total: count() }).from(bills),
  ]);
  const plan = planCleanup({
    files,
    referencedPaths: referenced.map((row) => row.path).filter((path): path is string => path !== null),
    billCount: total,
    now: Date.now(),
    force,
  });

  if (plan.refusal) {
    console.error(`Nothing deleted. ${plan.refusal}`);
    return 3;
  }
  if (!apply) {
    console.log(`${files.length} photos checked, ${plan.orphans.length} abandoned. Nothing deleted, because --delete wasn't given.`);
    return 0;
  }
  let deleted = 0;
  for (const file of plan.orphans) {
    await deleteReceiptImage(file.path);
    deleted++;
  }
  console.log(`${files.length} photos checked, ${deleted} abandoned deleted.`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  // Only the message: a driver error object can carry the connection details.
  console.error(`Receipt cleanup failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}

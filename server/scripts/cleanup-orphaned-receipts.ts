/**
 * Deletes receipt images in Storage that no bill references — left behind
 * when someone uploads a photo via POST /api/bills/extract (which stores
 * the image before a bill exists, so extraction failures still preserve
 * it) and then abandons the review screen without confirming a bill.
 *
 * Render's free tier has no built-in cron, so this is a script you run
 * occasionally rather than a scheduled job — deliberately simple per the
 * Phase 5 plan. Only removes files older than 24h, so an in-progress
 * upload never gets deleted out from under an active review screen.
 *
 * Run from server/: npx tsx scripts/cleanup-orphaned-receipts.ts
 */
import "dotenv/config";
import { db } from "../src/db.js";
import { listReceiptImagePaths, deleteReceiptImage } from "../src/lib/storage.js";

const MIN_AGE_MS = 24 * 60 * 60 * 1000;

async function main() {
  const [allFiles, referencedBills] = await Promise.all([
    listReceiptImagePaths(),
    db.query.bills.findMany({ columns: { receiptImageUrl: true } }),
  ]);

  const referencedPaths = new Set(
    referencedBills.map((b) => b.receiptImageUrl).filter((p): p is string => p !== null),
  );

  const now = Date.now();
  const orphaned = allFiles.filter(
    (f) => !referencedPaths.has(f.path) && now - new Date(f.createdAt).getTime() > MIN_AGE_MS,
  );

  if (orphaned.length === 0) {
    console.log(`Checked ${allFiles.length} receipt file(s) — no orphans found.`);
    return;
  }

  console.log(`Deleting ${orphaned.length} orphaned receipt file(s) of ${allFiles.length} total:`);
  for (const file of orphaned) {
    await deleteReceiptImage(file.path);
    console.log(`  deleted ${file.path} (uploaded ${file.createdAt})`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

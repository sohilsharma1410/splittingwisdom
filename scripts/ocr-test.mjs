#!/usr/bin/env node
// Runs receipt photos through POST /api/bills/extract and prints what Gemini read, so we can
// judge accuracy before building the review screen (plan D3.3).
//
//   OCR_EMAIL=you@example.com OCR_PASSWORD='...' node scripts/ocr-test.mjs <base-url> receipt1.jpg receipt2.jpg ...
//
// Credentials come from the environment so they don't land in shell history or chat. The server
// allows 10 extractions per user per hour. It stores each photo (on the Pi: in its receipts folder).
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const [base, ...files] = process.argv.slice(2);
const { OCR_EMAIL, OCR_PASSWORD } = process.env;
if (!base || files.length === 0 || !OCR_EMAIL || !OCR_PASSWORD) {
  console.error("usage: OCR_EMAIL=... OCR_PASSWORD=... node scripts/ocr-test.mjs <base-url> <image> [<image>...]");
  process.exit(1);
}
const BASE = base.replace(/\/$/, "");
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const rupees = (p) => (p == null ? "—" : `₹${(p / 100).toFixed(2)}`);

const login = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: OCR_EMAIL, password: OCR_PASSWORD }) });
if (!login.ok) { console.error(`Login failed (${login.status}): ${(await login.json().catch(() => ({})))?.error?.message ?? ""}`); process.exit(1); }
const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

for (const file of files) {
  const mime = MIME[extname(file).toLowerCase()];
  console.log(`\n=== ${basename(file)} ===`);
  if (!mime) { console.log("  skipped: use a .jpg, .png or .webp (iPhone HEIC isn't supported yet)"); continue; }
  const form = new FormData();
  form.append("image", new Blob([readFileSync(file)], { type: mime }), basename(file));
  const started = Date.now();
  const res = await fetch(`${BASE}/api/bills/extract`, { method: "POST", headers: { Cookie: cookie }, body: form });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const body = await res.json().catch(() => null);
  if (!res.ok) { console.log(`  HTTP ${res.status}: ${body?.error?.message ?? "error"}`); continue; }
  const { extraction: x, extractionFailed, imagePath } = body.data;
  console.log(`  ${secs}s · photo stored: ${imagePath ? "yes" : "no"} · ${extractionFailed ? "EXTRACTION FAILED (see the server log for why)" : `overall confidence: ${x.overallConfidence}`}`);
  if (extractionFailed) continue;
  console.log(`  merchant: ${x.merchant ?? "—"}   date: ${x.billDate ?? "—"}`);
  for (const i of x.items) console.log(`    ${i.confidence === "low" ? "?" : " "} ${String(i.quantity).padStart(2)} × ${i.name.slice(0, 34).padEnd(34)} ${rupees(i.price).padStart(11)}`);
  console.log(`  tax added ${rupees(x.taxAmount)}${x.taxIncludedAmount ? ` (+ ${rupees(x.taxIncludedAmount)} already included in prices)` : ""} · tip ${rupees(x.tipAmount)} · service ${rupees(x.serviceFeeAmount)} · discount ${rupees(x.discountAmount)} · round-off ${rupees(x.roundOffAmount)} · TOTAL ${rupees(x.totalAmount)}`);
  console.log(x.totalsMismatch ? `  ⚠ totals mismatch: items+charges = ${rupees(x.totalsMismatch.itemsSum)} but receipt total reads ${rupees(x.totalsMismatch.extractedTotal)} (off by ${rupees(Math.abs(x.totalsMismatch.delta))})` : "  ✓ items + charges add up to the receipt total");
}
console.log("\nCompare each block to the paper receipt: wrong/missing items, wrong prices, and any '?' (low confidence) lines are what we need to hear about.");

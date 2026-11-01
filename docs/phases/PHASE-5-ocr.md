# PHASE 5 — Receipt upload, OCR extraction, review flow

Read `CLAUDE.md` and SPEC.md sections 2.2, 2.7, 3.2, 9 before planning. Phases 1–4 are live with real data.

Renumbered from the original Phase 3 — Phase 3 (registered-only members and
invite flow, bill-creation rework) and Phase 4 (Splitwise-inspired redesign)
were inserted ahead of this one, since building the OCR review screen against
a UI and member model both about to change would mean building it twice.
Scope below is otherwise unchanged from the original Phase 3 plan.

**Goal:** photograph or upload a receipt → server extracts merchant, date, line items, tax/tip/charges via Gemini → user reviews and corrects everything on a review screen → confirms → lands in the Phase 2 assignment flow. OCR is an accelerant for the existing manual flow, never a replacement or a gate: every failure path must degrade gracefully into manual entry with the image preserved.

**First produce a numbered implementation plan for my approval. Do not write code until I approve.**

## Scope

### 1. Image upload + storage — ✅ shipped (code-complete, needs your Part 0 setup to actually work in production)
- Server: `server/src/lib/storage.ts` — a lazily-initialized Supabase Storage client (never at module-import time, specifically so a missing key can't crash the whole server on boot — see the note below), `uploadReceiptImage`/`getReceiptSignedUrl`/`deleteReceiptImage`/`listReceiptImagePaths`. Images live at `receipts/<userId>/<nanoid>.<ext>` in a bucket named `receipts`, which **must be private** — only ever served back via a signed URL with a 10-minute expiry, never a public link.
- `POST /api/bills/:id/receipt` (multipart, `multer`, memory storage, 10MB limit, jpeg/png/webp only — HEIC intentionally out of scope for now, see below) and `GET /api/bills/:id/receipt-url`, both gated by the same group-membership check every other bill route uses.
- Client: `client/src/lib/downscale-image.ts` (plain `<canvas>`, caps the longest edge at 2000px, no new dependency), a `ReceiptSection` component on Bill Detail ("Add receipt photo" / "View receipt" → a full-image dialog), and a small camera icon on Activity cards that have one.
- `shared/schema.ts`: `receiptImageUrl` added to `insertBillSchema`'s pick list — the only schema change (the column already existed from an earlier phase).
- **A real deployment risk caught and fixed during this work**: both the Supabase and Gemini clients originally threw at module-import time if their env vars were missing. Since `bills.ts` imports both unconditionally, pushing that as-is would have crashed the *entire* server on boot the moment it deployed — taking Phases 1-4 down too, not just the new receipt features. Fixed by lazily creating both clients on first actual use; verified live that the server boots and every existing route still works with neither `GEMINI_API_KEY` nor real Supabase Storage credentials set, and that hitting the new upload route without them fails gracefully (a normal 500, not a crash).
- **What you need to do before this actually works**: create a **private** Supabase Storage bucket named `receipts`, and set `SUPABASE_SERVICE_KEY`/`SUPABASE_URL` for real (currently placeholder/empty in `server/.env`) — locally and in Render's environment for production.

### 2. Extraction service — ✅ shipped (code-complete, same Part 0 gate)
- `server/src/lib/gemini.ts` — `extractReceipt(buffer, mimeType)`, calling `gemini-2.0-flash` with a strict-JSON prompt (paise amounts, `null` rather than guessing, never inventing items), 30s timeout via `AbortSignal`, Zod-validated with per-field `.catch()` fallbacks rather than rejecting the whole response over one bad field, code-fence stripping. Any failure (timeout, API error, unparseable response) returns `null` — the caller treats that as `extractionFailed: true`, never a 500.
- `POST /api/bills/extract`: uploads to Storage *before* calling Gemini, so a failed extraction still returns a usable `imagePath` and the photo is never lost (SPEC §2.7). Rate-limited at 10/hour per user via the existing `rateLimit()` helper (`server/src/middleware/rate-limit.ts`, already used by `/api/users/search` — just a new call site, no new rate-limiting code).
- Totals-mismatch check runs in this codebase, not trusted from the model: sums `items[].price × quantity` + tax/tip/fee − discount and compares to the extracted total, returning `{ itemsSum, extractedTotal, delta }` when they disagree.
- `server/scripts/cleanup-orphaned-receipts.ts` (since replaced by `server/src/tools/cleanup-receipts.ts`) — an occasional-run script (Render's free tier has no cron) that deletes Storage files older than 24h with no bill referencing them, for images left behind by an abandoned review screen once Part 3 exists.
- **HEIC scoped out of v1**: iPhones default their camera to HEIC, which browsers can't canvas-downscale and Gemini doesn't reliably accept — full support means a real added dependency. Given this session's testing has been on Android (default camera format JPEG), a HEIC upload gets a clear "please use JPEG or PNG" error instead. Easy to add later if it turns out to matter.
- **Checkpoint B — this is the pause point, not yet reached**: once you've done the Part 0 setup above and added `GEMINI_API_KEY`, test with 5 real receipts (crisp printed, crumpled, long grocery, handwritten, dim photo) via a direct API call — we look at extraction quality and `totalsMismatch` behavior together before I write a single line of the review-screen UI (Part 3, unstarted).

### 3. Review screen (SPEC §9 — this is where trust is won)
- Layout: receipt image beside (desktop) or above (mobile) the editable extraction. Skeleton rows shimmer during processing with stage text ("Reading receipt…").
- Every extracted field editable inline. Low-confidence fields visually marked (icon + amber outline + "please check" text — not color alone) and listed in a "Needs review" summary at top.
- Item rows: edit name/price/qty, delete, add missing item, reorder. Charges editable. Totals mismatch banner with the delta shown ("Items sum to ₹1,340 but receipt total reads ₹1,390 — off by ₹50") and one-tap "use items sum as total".
- Group selector + payer selector + date (defaulting to extracted values where present).
- Explicit **Confirm bill** action creates the bill + items and routes straight into the Phase 2 assignment view. Back/cancel discards cleanly with confirmation if edits were made.
- Failure paths: extraction failed or user hits rate limit → same review screen, empty items, image displayed, message "Couldn't read this receipt — add the items manually", manual entry fully functional. Upload succeeded but user abandons → no orphan bill created; orphaned storage images cleaned up by a simple scheduled cleanup or on-next-upload sweep.
- **Checkpoint C: commit + tag `v0.5` + deploy.**

## Out of scope
Settlements, PDF receipts, multi-receipt bills, editing the receipt image itself, storing Gemini responses beyond the created bill.

## Definition of done — I will personally verify
- [ ] Checks, tests, build pass.
- [ ] Phone camera → capture a real restaurant receipt → items appear → I fix one wrong price → confirm → assign → balances correct end to end.
- [ ] A deliberately unreadable photo (my desk) fails gracefully into manual entry with the image kept.
- [ ] Low-confidence fields are visibly flagged on at least one messy receipt.
- [ ] Totals-mismatch banner appears when I edit an item to break the sum, with the correct delta.
- [ ] Receipt image on a bill is visible to a group member and NOT accessible to a logged-in non-member (test the signed URL as the other user), nor via the raw storage URL logged out.
- [ ] The whole flow at a table with one hand in under 2 minutes for a simple receipt.
- [ ] Phase 1 + 2 regression checklists still pass.

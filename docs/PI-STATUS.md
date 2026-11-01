# Pi status and handoff

Where the Pi work stands, for anyone picking it up. Last updated 2026-11-01.
Task IDs refer to `PLAN-PI-PRODUCTIONIZATION.md`. How to run the stack is in
`deploy/pi/README.md`.

The repo is public, so login names, LAN details, the tailnet name and the Funnel URL
aren't recorded here. Ask the owner for them. Only the owner can reach the Pi, so any
command that has to run there goes through them.

## Where things stand

| Milestone | State | Evidence |
|---|---|---|
| M1 Pi base | Done | On the Pi: `smoke.sh` 62/62, and login survived a full restart. The owner confirmed the stack comes back after a reboot |
| M2 Migration rehearsal | Done, except P4.5 and P4.7 | On the Pi against real Supabase: `copy-from-supabase.sh` ended `RESULT: OK` (table below), then `smoke.sh` 62/62 on the copy |
| M3 Funnel and PWA | Done | Owner-reported, no logs kept: see below |
| M4 Sync and failover | On hold (D18) | The code is on `main` and Render runs it, but sync isn't switched on |
| Local OCR | Steps 1-3 passed on the Pi, on `dev-ocr`. Step 4 needs real bills | See below |
| Merge to `main` | Waiting on the collaborator's UI work (D19) | See "Merge plan" |

**M2 row counts, identical on the Pi and Supabase:** users 25, groups 11,
group_members 28, bills 11, bill_items 21, item_assignments 53, settlements 0. Rows
and per-pair balances matched too. `updated_at` and `origin` are left out of the row
comparison, because the restore sets them on the Pi.

**M3, as tested by the owner on Android and iPhone:** installed from the public URL,
stayed logged in after closing the app, created a group and a bill with the right
balance, and took a receipt photo with the camera and opened it again. Automatic
receipt scanning wasn't part of the test.

## Local OCR

The owner chose to run receipt OCR on the Pi instead of Gemini (D18). The plan is RapidOCR
plus a parser, because vision models can invent prices. Scanning falls back to manual
entry on Render.

**Step 1, the speed test (`deploy/pi/ocr-spike/`), passed on the Pi.** On 24 public samples
at phone-photo size, with 3 threads and no network:

| Model | Typical scan | Slowest | Peak memory | Slowest app health check |
|---|---|---|---|---|
| Small (chosen) | 2.8s | 6.4s | 734 MB | 0.01s, none failed |
| Tiny | 1.3s | 2.3s | 516 MB | 0.01s, none failed |

The health check doesn't query the database, so step 3 should recheck with real requests.
On the Pi the small model found prices 39/39 and totals 17/19 on real photos, and prices
29/30 and totals 4/4 on the invoices. The table below is a larger run, on x86.

| 120 public samples, x86 | Prices found | Totals found | Item names exact | Typical time |
|---|---|---|---|---|
| Tiny model, real photos (CORD-v2) | 224/246 | 86/95 | 185/246 | 1.0s across both sets |
| Small model, real photos (CORD-v2) | 233/246 | 91/95 | 210/246 | 2.8s across both sets |
| Tiny model, synthetic Indian invoices | 165/167 | 20/20 | 113/167 | |
| Small model, synthetic Indian invoices | 161/167 | 20/20 | 140/167 | |

These numbers are a best case for prices and totals: a value counts if it appears anywhere
on the page, not only on the right row. The samples aren't Indian restaurant bills: CORD-v2
is Indonesian, and the Indian set is synthetic wholesale invoices. Real Indian bills are
still needed before the accuracy test in step 4.

**Memory limits don't work on the Pi yet.** Docker reports that the kernel doesn't support
them, so `--memory` is ignored. The OCR service needs a cap in step 3, which means turning on
the kernel's memory cgroup and rebooting. Until then, a limit in Compose wouldn't protect
Postgres and the API. The test doesn't set one and reports peak memory instead.

Rows from tilted photos come back out of order, so the parser has to use the text's
position on the page. Receipt photos must never be committed, because the repo is public.

**Step 2, the parser, is `server/src/lib/receipt-parser.ts`.** It isn't connected to the app
yet. It only uses made-up receipts in its tests. An item's `price` is the line total, because
balances use `price` directly and never multiply by quantity.

| Parser on 120 public samples, small model, x86 | Items right | Totals right | Totals wrong | No total | High confidence |
|---|---|---|---|---|---|
| Real photos (CORD-v2, 100) | 174/232 | 68/87 | 6 | 13 | 29, every checkable total right (28/28) |
| Synthetic Indian invoices (20) | 151/167 | 20/20 | 0 | 0 | 0 |

All 6 wrong totals were marked low confidence, mostly from OCR misreads. 9 real photos gave no
result and would go to manual entry. The CORD-v2 run rewrites rupiah amounts to plain numbers
and isn't tuned to Indonesian wording, so it tests structure, not Indian bills. The invoices
are never high confidence because they print rounded line totals that don't add up exactly.
Real Indian restaurant bills are still untested.

**Step 3, the service, is `deploy/pi/ocr/` and `server/src/lib/receipt-extract.ts`.** On the Pi,
`POST /api/bills/extract` uses the `ocr` container. There's no scan screen yet, so people can't
reach this from the app. Its network has no internet and holds only it and the API, and it's
limited to 1500 MB and 3 cores. On x86 without Docker, the real flow passed `qa-smoke` 70/70. On the
Pi, `deploy/pi/smoke.sh` also passed 70/70, with a scan taking 2.2s and the slowest database request
during it 49 ms. It confirmed no internet from the container, no route to Postgres, no host port, an
enforced memory limit, and the app working with OCR stopped. An unknown `OCR_PROVIDER` fails the scan, so a typo can't send photos to Google. Render
will use Gemini by default when it gets this code, or manual entry if it has no key, so M4 needs a
decision on that.

**Step 4, real bills, will be tested directly in the app** once the merged scan screen is running.
Until then, nothing has been tested on a real Indian bill.

**Abandoned scan photos:** `server/src/tools/cleanup-receipts.ts` deletes photos that no bill uses, weekly
once `deploy/pi/splittingwisdom-cleanup.timer` is installed. It refuses if the database has no bills or if it
would delete most photos, so restore the database before copying receipts at cutover.


## Merge plan

Agreed by both collaborators (D18, D19). Local OCR is the primary and Gemini is the secondary.

1. The collaborator finishes the UI screens and merges to `main`.
2. `main` merges into `dev-ocr`.
3. Gates and `deploy/pi/smoke.sh` pass, then `dev-ocr` merges to `main`. Render and Vercel deploy on every push to `main`.
4. Both collaborators update, check they're on the same page, and decide what's next.

**Prepared so far:** `dev-ocr` has `dev-pi` merged in, up to `50c5d67`, and local OCR fills the review screen's format.
To stay in step, run `git merge origin/dev-pi` on `dev-ocr` as more arrives. Build, type check and unit tests pass. Integration tests pass apart from the two intermittent failures below. `qa-smoke` passes 73/73
through the real OCR service on x86. Not yet checked: the merged code on the Pi, and the scan screen in a browser with local OCR.

**How they fit together:**

- `OCR_PROVIDER=rapidocr` selects local OCR, and `deploy/pi/docker-compose.yml` sets it. `OCR_PROVIDER=local` is not this: on
  `dev-pi` it means a local model server such as Ollama.
- `server/src/lib/receipt-extract.ts` is a thin wrapper. It sends `rapidocr` to the `ocr` container and everything else to
  `receipt-ocr.ts` unchanged. `routes/bills.ts` imports from the wrapper. Keep that import when merging.
- The parser fills `roundOffAmount` and `taxIncludedAmount`, and uses the shared `computeTotalsMismatch`, including its 50-paise tolerance.
- `ocrInfo()` in the wrapper doesn't throw on a bad setting. The one in `receipt-ocr.ts` does, which would fail the request
  after the photo is saved.
- `scripts/ocr-test.mjs` keeps `X-Forwarded-Proto`, so it can log in from the Pi itself.

**Decisions:**

- **When Gemini is used:** the Pi reads with local OCR only, and failed scans go to manual entry. Render uses Gemini during an
  outage, because it can't run local OCR. A Pi that falls back to Gemini would send photos to Google. The owner agreed; the
  collaborator should confirm.
- **`dev-pi` tests use a real receipt's values** (`client/src/lib/receipt-draft.test.ts`), including a real merchant name. No
  photo or personal details were found, but the repo is public, so confirm that's fine.

## Speaking the split (idea, not connected to the app)

See `BACKLOG.md`. The owner agreed the direction: test plain matching first, and speech may go to Google or Apple if the app
says so. `server/src/lib/speech-split.ts` only links item numbers to member ids and share counts, and never sees an amount.

| Plain rules, no model | Exact | Left blank | Wrong guess |
|---|---|---|---|
| 30 casual sentences, first run | 16 | 5 | 9 |
| The same 30, after adding rules that hold back | 19 | 11 | 0 |
| 40 simpler sentences (`DEV_CASES`, `HELD_OUT_CASES`) | 40 | 0 | 0 |

The same person wrote the rules and all the sentences, so the first row is the most honest number, and the zeros aren't proven.
The test that counts is real people's real speech, run through real speech recognition. Casual phrasing like "so did Ravi" still
ends up blank, which is the case for adding a small model. No model has been tried.

## What runs where

| | Pi | Render and Vercel | Supabase |
|---|---|---|---|
| Code | `dev-ocr` | `main` (`cd13037` when checked): settlements and sync code, no review screen or local OCR yet | Migrations 0004-0007 not confirmed |
| Data | M3 test accounts only | Live app | The owner says it holds only dummy data for now |
| Sync | Off | Off | Not receiving anything |

## The Pi

- Pi 5 16 GB, Raspberry Pi OS Lite (Trixie, 64-bit), hostname `firebatpi`.
- **4K-page kernel** (`kernel=kernel8.img`, D14). The default 16K kernel can break
  software built for 4K pages.
- **Tailscale runs on the host**, tagged `tag:server` (D13). Funnel forwards port 443
  to `127.0.0.1:4000`. Docker-published ports bypass ufw, so the API binds to localhost
  and Postgres isn't published.
- **SSH uses a password for now** (D15), limited to the LAN and the tailnet by ufw. This
  is why P1.1 is still open.
- **Memory cgroup:** off, so Docker memory limits are ignored (see Local OCR above).
- **Swap:** Trixie uses `rpi-swap`, so `dphys-swapfile` doesn't exist.
- **Flashing:** Raspberry Pi Imager below 2.0 silently skips customisation on Trixie.
  Use 2.x and check that `user-data` on `bootfs` has your settings before booting.

## Migration details worth knowing

- **Use the session pooler** (port 5432 on `*.pooler.supabase.com`). The transaction
  pooler can't run `pg_dump`, and the direct host is IPv6-only.
- **Only the 7 app tables are copied.** Sessions aren't, so users log in again after a
  cutover.
- **Triggers are off during the restore,** so copied rows don't enter `sync_outbox` or
  `deletion_log`.
- **Passwords carry over.** A copied user logged in with their old password in the
  local test of the script. That wasn't repeated on the Pi.
- **Copied settlements are untested on the Pi,** because Supabase has none. The script
  was tested locally against an old-schema stand-in, using test data.

## Open items

| Item | Detail | Owner |
|---|---|---|
| **Failback test race** | See below. Fix first in M4 | Collaborator, or M4 |
| **Pi data before sync** | The Pi holds M3 test accounts, whose IDs would collide with Supabase's rows. Before starting sync, wipe the Pi and rerun `copy-from-supabase.sh`, which needs Funnel off | M4 |
| **Supabase schema** | **Check this now.** `main` is live on Render, but the collaborator's checklist (F1) still lists migrations 0004-0007 as not applied. Check the version, back up, and apply them | Owner and collaborator |
| **Standby code** | Render and Vercel must run the same build as the Pi (S7.5). They're now on `main`, while the Pi is on `dev-ocr` | After D19 |
| **Failover URLs** | Left out of the Pi build on purpose (D17). Set `VITE_PRIMARY_URL` and `VITE_STANDBY_URL` and rebuild once sync runs | M4 |
| **Vercel bot check** | Scripted requests to `/api/*` through Vercel got a 429 challenge page (`x-vercel-error: hibernate-rate-limited` on `/api/health`), while Render answered directly. Check in a browser. Could also block keep-alive pings through Vercel (S1.3) | Owner to check |
| **Receipts on Supabase (P4.7)** | Skipped because the data is dummy. Recheck at cutover: `SELECT count(*) FROM bills WHERE receipt_image_url IS NOT NULL;` | Cutover |
| **Receipts on the standby (S2.5)** | Not copied yet, so they won't show during an outage | Collaborator |
| **`SESSION_SECRET` (P3.5)** | The Pi has its own. Copy Render's at cutover. Cookies were checked behind Funnel; shared sessions weren't | Cutover |
| **Cutover runbook (P4.5)** | Not written. It depends on the sync setup from M4 | M6 |
| **Funnel ACL (P5.2)** | Not confirmed against the plan's wording | Owner |

## The failback test race

`server/test/failback.int.test.ts:410`, "if the state moved while the reverse sync
ran…", fails intermittently.

**Likely cause, from reading the code:** the test's `onResult` starts a `system_state`
update without waiting for it. `handleCutover` in `server/src/failback/worker.ts`
doesn't wait either, and goes straight to `transitionSystemState`. If that runs first,
the epoch still matches, the cutover completes, and the test's `lost-race` expectation
fails. The compare-and-swap looks correct, so this points to a test bug, not a
failover bug. It hasn't been reproduced on demand.

**Suggested fix, not applied:** let `onResult` return a promise, `await` it in the
worker, and have the test return its update. That forces the order the test intends.

**It isn't caused by the Pi or OCR work.** On untouched `dev-pi` (`3213a6f`), the full integration suite failed this test in
2 of 6 runs. An earlier baseline of 0 in 5 was luck.

## Another intermittent test failure

`server/test/roles.int.test.ts`, "after a failover the roles swap…", failed once with Postgres `deadlock detected`, in 1 of
4 full runs on `dev-ocr` after merging `dev-pi`. It passed 4 of 4 alone, and didn't appear in 6 runs on untouched `dev-pi`.
Test files run one at a time, so the likely cause is a background timer from an earlier test colliding with `truncateAll`.
That's unproven, and the test doesn't touch OCR code.

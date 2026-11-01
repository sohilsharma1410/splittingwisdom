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
| M4 Sync and failover | Not started | The code is on `dev-pi`, but nothing is deployed or switched on |

**M2 row counts, identical on the Pi and Supabase:** users 25, groups 11,
group_members 28, bills 11, bill_items 21, item_assignments 53, settlements 0. Rows
and per-pair balances matched too. `updated_at` and `origin` are left out of the row
comparison, because the restore sets them on the Pi.

**M3, as tested by the owner on Android and iPhone:** installed from the public URL,
stayed logged in after closing the app, created a group and a bill with the right
balance, and took a receipt photo with the camera and opened it again. Automatic
receipt scanning wasn't part of the test.

## What runs where

| | Pi | Render and Vercel | Supabase |
|---|---|---|---|
| Code | `dev-pi` | Old `main`: no settlements route | n/a |
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
| **Supabase schema** | Believed to be at migration 0003, based on `main`, not confirmed. Check it, back up, then apply migrations before forward sync | M4 |
| **Standby code** | Render and Vercel must run the same build as the Pi (S7.5) | M4 |
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

**Record so far:**

| Run | Failed |
|---|---|
| Full gates on Pi branches | 3 of 7 |
| Integration suite alone on Pi branches | 0 of 7 |
| That test file alone on Pi branches | 0 of 4 |
| Untouched `dev-pi`, before the Pi work (only 1 of these was a full gate run) | 0 of 5 |

Failures only appeared in full gate runs, which fits a timing race but doesn't prove it.
The Pi work doesn't touch this code. The last 3 full gate runs before merging M2 all
passed, so the race is probably still there rather than fixed.

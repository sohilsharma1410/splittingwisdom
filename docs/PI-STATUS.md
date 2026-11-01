# Pi status and handoff

Where the Pi work stands, and what to do next, for anyone picking it up. Last updated 2026-11-01.
Task IDs refer to `PLAN-PI-PRODUCTIONIZATION.md`. How to run the stack is in
`deploy/pi/README.md`.

The repo is public, so login names, LAN details, the tailnet name and the Funnel URL
aren't recorded here. Ask the owner for them. Only the owner can reach the Pi, so any
command that has to run there goes through them.

## Current work

Sohil fixes scan bugs on `dev-bugfixes`, and the owner's session builds speech-to-text on `dev-speech` (D20, D21). The bug
details, the money rules for them and how the two branches avoid clashing are in `PLAN-PI-PRODUCTIONIZATION.md` §6
"Current work" and D3.9-D3.11. M4 stays on hold.

## Action items for the Pi (start here)

Everything the Pi developer and the owner need to do next, in order, against `main` (2026-11-01).
The repo is public: **never put keys, passwords, the tailnet name or the Funnel URL in it.** Secrets go in
`deploy/pi/.env` on the Pi (git-ignored, `chmod 600`). `<funnel-url>` below means the Pi's public URL; ask the owner.
The master before-go-live list is Appendix F of `PLAN-PI-PRODUCTIONIZATION.md` (same IDs).

**Marks:** `[PI]` you do it on the Pi. `[OWNER]` only the owner can (dashboards, secrets, phones). `[CLAUDE]` a Claude session can do it with you.

### 0. What's new since you last pulled

Branch `main` now contains everything from `dev-pi`. You already have the Pi stack (P2/P3) and the M2 rehearsal; since then:

| Area | What changed | Touches the Pi? |
|---|---|---|
| Settlements | Record payments, partial payments, payment history, derived Settled/Pending | New migrations; client + API |
| Simplify debts | "Settle up" on a group; paying a suggestion is recorded as the chain of real debts | Client + API |
| **Receipt scanning (OCR)** | `/bill/new/scan`: photo -> read -> user checks -> confirm. Local OCR is the primary reader on the Pi, in its own `ocr` container (D18). Gemini or another model is available elsewhere | `docker compose build` adds the container. **No key needed on the Pi** |
| PWA | Installable app, offline shell, client-side failover (off unless both URLs are set) | Build args only |
| Security | Login rate limits (per IP + email), `helmet`, receipt-photo ownership check, idempotency keys on creating POSTs | Automatic |
| Database | Migrations **0004-0007**: idempotency keys, sync triggers, `deletion_log`, outbox, `system_state`, DEFERRABLE constraints | `migrate` service applies them |
| Timezone | Direct (non-pooler) connections now ask for a **UTC** session | Automatic |
| Sync / failover code | Forward sync agent, roles/fencing, controller, failback, integrity check | Code only; **off** until M4 |

---

### 1. Do now: update the Pi to `main` `[PI]`

```bash
cd ~/splittingwisdom && git pull origin main
cd deploy/pi
docker compose build            # ~10 min if dependencies changed
docker compose up -d            # reruns the migrate service first: applies 0004-0007
docker compose ps               # postgres + api + ocr healthy; migrate exited (0)
docker compose logs migrate     # should say migrations applied
./smoke.sh                      # QA-1; expect 73/73, plus the restart, isolation and OCR-down checks
```

- [ ] **PI-1** Pull `main`, rebuild, bring the stack up. Paste the `docker compose ps` output and the `smoke.sh` result into `docs/PI-STATUS.md`.
- [ ] **PI-2** Confirm migrations reached 0007: `docker compose exec postgres psql -U splittingwisdom -c "select count(*) from drizzle.__drizzle_migrations"` -> **8**.
- [ ] **PI-3** Confirm the database session is UTC: `docker compose exec postgres psql -U splittingwisdom -c "show timezone"` -> `UTC`. If not, add `-c timezone=UTC` to the postgres `command:` list in `docker-compose.yml`. (Timestamps are stored without a timezone and read back as UTC; a non-UTC database makes new bills look like "tomorrow" in the evening. Found locally on 2026-11-01.)
- [ ] **PI-4** Reboot test once more after the update (`sudo reboot`) and confirm the stack comes back healthy without a manual start.

If the `migrate` step fails, stop and read `docker compose logs migrate`. Do **not** edit or skip migrations by hand; send the log to the owner.

---

### 2. Receipt scanning (OCR) `[PI]` + `[OWNER]`

The Pi reads receipts itself, so it needs **no API key and no Supabase Storage**. `docker-compose.yml` runs the `ocr` container and sets `OCR_PROVIDER=rapidocr`. Photos stay on the Pi (D18). The Pi doesn't fall back to Gemini: failed scans go to manual entry.

- **PI-5, PI-6** No longer needed: there's no key to send or set on the Pi.
- [ ] **PI-7** `[PI]` Install the weekly cleanup of abandoned scan photos (`deploy/pi/README.md`).
- [ ] **PI-8** `[PI]` Check OCR is healthy:
  ```bash
  docker compose ps ocr
  docker compose logs api | grep -i "local ocr" | tail
  ```
  A failure line reads `Local OCR failed: <reason>`. It's never logged with the photo or its text.
- [ ] **PI-9** `[OWNER]` Test on a phone against `<funnel-url>`: log in -> New Bill -> **Scan a receipt instead** -> take a photo. Expect "Reading receipt…" for a few seconds, then the review screen with the items. Confirm saves a bill with the photo attached ("View receipt" on the bill opens it).
  - Limits to know: JPG/PNG/WebP only (iPhone HEIC is **not** supported yet; set the camera to "Most Compatible"); 10 MB max (the app shrinks photos first); 10 scans per user per hour.
- [ ] **PI-10** `[PI]` Make sure the receipts volume is in your backups (P6.3): it holds the only copy of every photo. Receipts are **not** copied to the standby yet (plan S2.5), so they won't show during an outage.

---

### 3. Verify the update on the Pi (QA) `[PI]` + `[OWNER]`

- [ ] **PI-11** `[PI]` `./smoke.sh` passes (also proves a login survives restarting the whole stack).
- [ ] **PI-12** `[OWNER]` On Android **and** iPhone, against `<funnel-url>`, install the app and check:
  1. Still logged in after closing and reopening the app.
  2. Dashboard -> Settle with a demo person -> partial payment -> balance updates without a refresh.
  3. A group with 2+ debts -> **Settle up** -> **Simplified** -> pay the suggestion -> the **Direct** tab is empty afterwards.
  4. Dark mode: no white flash on reload.
  5. Scan a receipt (PI-9).
- [ ] **PI-13** `[PI]` Run the browser suite against the Pi if you can (needs Google Chrome on the machine running it): `E2E_PRIMARY_URL=<funnel-url> npx playwright test e2e/install-banner.spec.ts e2e/settlements.spec.ts e2e/simplify-debts.spec.ts e2e/scan-receipt.spec.ts`. The scan spec expects the fake model, so it will **not** pass against real Gemini; skip it there and use PI-9 instead.

---

### 4. Test the Pi -> backup -> Pi fallback (needs the owner) `[PI]` + `[OWNER]`

This tests **routing only**: there is no data sync yet, so the backup (Vercel + Render + Supabase) has different accounts and data from the Pi. People log in again on the backup.

Prerequisite: Supabase has all 8 migrations (**done 2026-11-01**) and Render/Vercel run `main` (**done**, `937ecfd`).

- [ ] **PI-14** `[OWNER]` In the Vercel project -> Settings -> Environment Variables, add for Production: `VITE_PRIMARY_URL=<funnel-url>` and `VITE_STANDBY_URL=https://splittingwisdom-client.vercel.app`. Then Deployments -> ... -> **Redeploy**. (Env changes only apply on a new build.)
- [ ] **PI-15** `[PI]` Rebuild the Pi with the same two values (they are baked into the client at build time):
  ```bash
  cd ~/splittingwisdom/deploy/pi
  VITE_PRIMARY_URL=<funnel-url> VITE_STANDBY_URL=https://splittingwisdom-client.vercel.app docker compose build
  docker compose up -d
  ```
  (Or put both in `.env`; compose reads them as build args.) Both builds must come from the same commit.
- [ ] **PI-16** `[OWNER]` On a phone: open `<funnel-url>`, log in, install the app. No banner should show.
- [ ] **PI-17** `[PI]` Simulate a crash: `docker compose stop api`.
- [ ] **PI-18** `[OWNER]` Close the installed app fully and reopen it. Within ~15 s: "Main server unreachable — opening the backup app…", then you land on the Vercel address with a **Backup mode** bar. The first screen can take up to a minute (Render wakes from sleep). Log in with an account that exists in Supabase.
- [ ] **PI-19** `[PI]` `docker compose start api`. `[OWNER]` stay on the backup screen ~3 minutes: **Main server is back. Switch** appears; tap it to return to the Pi.
- [ ] **PI-20** `[PI]` + `[OWNER]` Harsher variant: pull the Pi's power instead of `stop api`. Same expectation; also confirm the Pi comes back by itself and PI-4 still holds.
- Not expected to work yet: failover for someone who has never installed the app and opens the Funnel URL while the Pi is down (Tailscale's error page; nothing of ours can run). Share both links with testers.

---

### 5. Before the Pi goes live (nothing here is optional)

Owner decision: Pi data and sync are deferred while the product is still changing. These are tracked here and in `PLAN-PI-PRODUCTIONIZATION.md` Appendix F (same IDs). Do not announce the Pi as the live app until all are ticked.

**Data**
- [ ] **F2** `[PI]` Wipe the Pi's test accounts and re-run `deploy/pi/copy-from-supabase.sh` (Funnel off while it runs) so Pi and Supabase IDs don't collide; verify with `server/src/tools/verify-migration.ts`.
- [ ] **F3** `[PI]` Check for receipts on Supabase: `select count(*) from bills where receipt_image_url is not null;`. The owner has none today; re-check at cutover and copy any to the Pi.
- [ ] **F4** `[PI]` Restores must not rewrite timestamps or fill the sync outbox: use `SET sw.sync_apply=on` or `--disable-triggers` (your script already disables triggers; keep it that way).
- [ ] **F5** `[PI]` + `[CLAUDE]` Write the cutover runbook (P4.5) and a rollback plan; rehearse once. Take a fresh Supabase backup first (the owner has taken one on 2026-11-01).

**Sync and failover (M4)**
- [ ] **F6** `[PI]` Turn sync on: `APP_ROLE=primary`, `SYNC_TARGET_DATABASE_URL`, `SYNC_TARGET_SSL=on` in `.env`, then `docker compose --profile sync up -d`. `APP_ROLE=standby` + `system_state` on Render; controller on Render. Setting these connects the Pi to the **real** Supabase database, so do it only after F2.
- [ ] **F7** `[CLAUDE]` + owner decision: sync idempotency keys between nodes (today a retry on the standby after a Pi success could record a payment twice). Recommended: build it.
- [ ] **F8** Owner decision: a Pi that can't read `system_state` on boot refuses writes, then stays writable 10 minutes after a successful read (`ROLE_STALE_GRACE_SECONDS`). Keep?
- [ ] **F9** `[CLAUDE]` Purge the outbox on nodes with no sync agent (Render) so it doesn't grow forever.
- [ ] **F10** `[PI]` Fix the flaky failback test (`server/test/failback.int.test.ts:410`, see `docs/PI-STATUS.md`).
- [ ] **F11** `[PI]` Copy receipts to the standby (plan S2.5).
- [ ] **F12** `[PI]` + `[OWNER]` Drills on the real Pi: failover, failback, power cut x10 (QA-5/6/7/8). Time the restore-from-standby script.

**Standby**
- [ ] **F13** `[OWNER]` Render and Vercel on the **same build** as the Pi, `VITE_*` set on both, and the **same `SESSION_SECRET`** on Pi and Render (the Pi has its own now; copy Render's at cutover. Changing it logs everyone out).
- [ ] **F14** `[OWNER]` Keep-alive: add GitHub secrets `SUPABASE_URL` + `SUPABASE_ANON_KEY` (workflow is already on `main`); confirm the run log says "Supabase REST API answered HTTP 200"; check the Supabase dashboard still says Active on ~Nov 12 and ~Nov 20.
- [ ] **F15** `[OWNER]` Open the Vercel app in a normal browser; scripted `/api/*` calls got a 429 bot challenge (`x-vercel-error: hibernate-rate-limited`). Confirm real browsers and the keep-alive aren't blocked.
- [ ] **F16** `[CLAUDE]` Render keep-warm pinger so a failover isn't a 40-second cold start.

**Access, security, ops**
- [ ] **F17** `[PI]` SSH keys only (no password, P1.1/D15); Funnel ACL matches the plan (P5.2).
- [ ] **F18** `[PI]` Backups: nightly dump + weekly offsite (P6.3, includes the receipts volume); restore rehearsed and timed.
- [ ] **F19** `[PI]` Alerts (P7.1) wired; decide on the log pipeline (P8).
- [ ] **F20** `[PI]` + `[OWNER]` Final regression on Android + iPhone against the Pi: every check in section 3 plus section 4.

---

### 6. Variable reference for `deploy/pi/.env`

| Variable | Needed now? | Notes |
|---|---|---|
| `POSTGRES_PASSWORD`, `SESSION_SECRET` | Yes (already set) | `openssl rand -hex 32` each |
| `GEMINI_API_KEY` | No | Not used for scanning on the Pi. Render uses Gemini during an outage, with these settings on Render: `GEMINI_API_KEY`, `GEMINI_MODEL`, `OCR_FALLBACK_MODEL`, `OCR_TIMEOUT_MS` |
| `OCR_MODEL`, `OCR_BASE_URL`, `OCR_API_KEY` | No | Only for trying a local vision model. Setting `OCR_PROVIDER` here would override nothing, because Compose sets it |
| `VITE_PRIMARY_URL`, `VITE_STANDBY_URL` | Only for the fallback test | Build-time; rebuild after changing; both or neither |
| `APP_ROLE`, `SYNC_TARGET_DATABASE_URL`, `SYNC_TARGET_SSL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | **No: leave off until F6** | Setting them connects the Pi to real Supabase |

Set by `docker-compose.yml` already (don't duplicate): `DATABASE_URL`, `DATABASE_SSL=off`, `DATABASE_POOLER=false`, `SERVE_CLIENT=true`, `STORAGE_DRIVER=local`, `RECEIPTS_DIR`, `OCR_PROVIDER=rapidocr`, `OCR_URL`.

---

### 7. Gotchas

- Changing `.env` -> `docker compose up -d` is enough. Changing code or `VITE_*` -> `docker compose build` first.
- `npm install <pkg> --workspace=...` removes a symlink `drizzle-kit` needs; run `node scripts/link-drizzle-orm.mjs` afterwards (fresh installs recreate it).
- Login cookies need HTTPS: log in through the Funnel URL, not `http://` or an SSH tunnel.
- Text accents in the client use `text-*-ink` classes (accessibility contrast); don't switch them back to `text-mint`/`text-coral`.
- If you add a Content-Security-Policy later: `client/public/theme-init.js` is a separate file so inline scripts can stay forbidden; fonts load from `fonts.googleapis.com` / `fonts.gstatic.com`.
- Don't create database migrations without telling the owner: numbering is shared across workstreams (0004-0007 are taken).
- Receipts: JPG/PNG/WebP only, 10 MB, 10 scans/user/hour.

### 8. What you are NOT waiting on anyone for

OCR, the review screen, settlements, simplify debts and the PWA are finished and tested; the owner runs them locally without the Pi. You're needed for: the rebuilds (PI-1, PI-15), the crash/power tests (PI-17..20), and section 5.

---

## Where things stand

| Milestone | State | Evidence |
|---|---|---|
| M1 Pi base | Done | On the Pi: `smoke.sh` 62/62, and login survived a full restart. The owner confirmed the stack comes back after a reboot |
| M2 Migration rehearsal | Done, except P4.5 and P4.7 | On the Pi against real Supabase: `copy-from-supabase.sh` ended `RESULT: OK` (table below), then `smoke.sh` 62/62 on the copy |
| M3 Funnel and PWA | Done | Owner-reported, no logs kept: see below |
| M4 Sync and failover | On hold (D18) | The code is on `main` and Render runs it, but sync isn't switched on |
| Local OCR | On `main`. Passed on the Pi before the merges, not yet rerun since. Real bills untested | See below |
| Merge to `main` | Done (D19) | See "Merge plan" |

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

1. Done: the collaborator merged the UI screens to `main`.
2. Done: `main` merged into `dev-ocr`, and `dev-ocr` merged to `main`. Render and Vercel deploy on every push to `main`.
3. Done: the next work is decided, see "Current work" at the top.

**Done:** both sides are on `main`. Before merging, gates passed and `qa-smoke` passed 73/73 through the real OCR service on x86. Still to do: run the merged code on the Pi, and try the scan screen in a browser with local OCR.

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
  collaborator should confirm, since their notes had assumed Gemini on the Pi.
- **`dev-pi` tests use a real receipt's values** (`client/src/lib/receipt-draft.test.ts`), including a real merchant name. No
  photo or personal details were found, but the repo is public, so confirm that's fine.

## Speaking the split (approved to build, not connected to the app yet)

The plan is D21 and D4.9-D4.12: English only, with speech recognition on the Pi if the test passes, so this replaces the
earlier idea of sending speech to Google or Apple. `server/src/lib/speech-split.ts` only links item numbers to member ids and
share counts, and never sees an amount. These results predate the English-only decision.

| Plain rules, no model | Exact | Left blank | Wrong guess |
|---|---|---|---|
| 30 casual sentences, first run | 16 | 5 | 9 |
| The same 30, after adding rules that hold back | 19 | 11 | 0 |
| 40 simpler sentences (`DEV_CASES`, `HELD_OUT_CASES`) | 40 | 0 | 0 |

The same person wrote the rules and all the sentences, so the first row is the most honest number, and the zeros aren't proven.
The test that counts is real people's real speech, run through real speech recognition. Casual phrasing like "so did Ravi" still
ends up blank, which is the case for adding a small model. No model has been tried.

### Speech recognition test (D4.9, `deploy/pi/stt-spike/`)

**Pass bars for the Pi, set before running it:**

| Measure | Bar |
|---|---|
| A recording of up to about 30 seconds | Typically 10s or less alone, and 20s or less during OCR scans |
| Memory | Stays inside the 1500 MB limit, with no failed clips |
| The app during the test | No failed health checks, and the slowest under 1s |
| Silence | Comes back empty |

**Results on the Pi: all four bars passed.** Awaiting the owner's approval before D4.10. Each run used the prompt and beam 1, in a container with no network, 3 cores and a 1500 MB limit.

| Run | Clips | Typical | Slowest | Clips of 15s or more, slowest | Time per second of speech | Peak memory | Slowest app check |
|---|---|---|---|---|---|---|---|
| `tiny.en` alone | 281 | 0.9s | 11.2s | 2.7s | 0.27s | 429 MB | 0.02s |
| `base.en` alone | 281 | 1.8s | **43.5s** | 3.6s | 0.50s | 658 MB | 0.02s |
| `base.en` alone, no retries | 107 | 1.9s | 4.9s | none in this set | 0.33s | 365 MB | 0.02s |
| `tiny.en` during scans | 18 | 4.9s | 10.7s | 10.7s | 0.38s | 315 MB | 0.01s |
| `base.en` during scans | 18 | 8.3s | 16.2s | 16.2s | 0.62s | 384 MB | 0.03s |

No app health check failed and no clip failed. Silence came back empty. Accuracy on the Pi matches x86 within a few points:

| Run | Real voices: word errors | Real voices with background speech: word errors | Generated voices: names and dishes kept | Same, with background speech |
|---|---|---|---|---|
| `tiny.en` | 19.1% | 55.3% | 359/420 | 68/93 |
| `base.en` | 13.6% | 40.3% | 358/420 | 73/93 |
| `base.en`, no retries | 13.5% | 37.4% | not run | 73/93 |

**Settings for D4.10: `base.en`, prompt, beam 1, no retries.** Retries caused the 43.5s worst case and didn't improve accuracy. The set with no retries was smaller and left out the clips of 15s or more, so the service must be timed again with these settings.

**During scans:** a receipt scan rose from about 2.2s to 4.7-4.8s, and its slowest was 17.5s. That was with scans running back to back, which is worse than real use, and with retries on. It's inside the 20-second target but not by much.

**Not measured:** upload and decoding time, and recordings from a real browser. The clips were encoded to match phone formats, not recorded on phones. Background speech alone still produces invented text, with or without retries, such as "He was a male...". The onnxruntime telemetry warning in the output is harmless: the container has no network.

**Results on x86, for comparing settings.** 281 clips, using faster-whisper 1.2.1 with int8 and 3 threads, beam 1 unless noted.

| Setting | Real voices: word errors | Real voices with background speech: word errors | Generated voices: names and dishes kept | Same, with background speech |
|---|---|---|---|---|
| `tiny.en`, no prompt | 19.3% | 55.3% | 171/420 | 31/93 |
| `tiny.en`, prompt | 18.9% | 56.8% | 359/420 | 69/93 |
| `base.en`, no prompt | 13.3% | 37.4% | 227/420 | 38/93 |
| `base.en`, prompt | 13.3% | 36.9% | 356/420 | 73/93 |
| `base.en`, prompt, no retries | 13.3% | 35.4% | not run | 73/93 |
| `base.en`, prompt, beam 5 | 11.2% | 59.7% | 366/420 | 77/93 |

- **The prompt matters most.** Giving Whisper the group's names and the bill's items roughly doubled the names and dishes on `tiny.en`. The app knows both when someone speaks. `hotwords` gave about the same result, so the test uses the simpler prompt.
- **`base.en` is better on real voices**, while `tiny.en` keeps up on generated names and dishes only with the prompt. The generated voices can't settle this, so the current lean is `base.en` if the Pi is fast enough.
- **Retries:** turning them off cut the slowest clip from 9.4s to 1.8s with no loss of accuracy. Without them, background speech alone came back as "The Paneer Butter", taken from the prompt. Silence stayed empty.
- **Beam 5:** not worth it. A little better on clean speech, much worse with background speech.
- **`faster-whisper` 1.2.1's own audio decoder fails on `av` 19**, so the test decodes audio itself. The real service must do the same.

**Words to the split matcher.** Generated voices, `base.en` with prompt, counted as exact / left blank / wrong guess:

| Sentences | Hindi voices | US voice |
|---|---|---|
| Short | 67 / 38 / 7 | 38 / 16 / 2 |
| Long | 1 / 4 / 3 | 1 / 2 / 1 |
| Long, background speech | 0 / 2 / 6 | 1 / 2 / 1 |

Given these same 60 sentences as perfect text, the matcher scores 48 / 12 / 0.

**The rules that avoid wrong guesses on clean text do make them on imperfect transcripts,** and longer speech is the real use. D4.12 has to deal with this before it can be trusted: for example, "chas" for "chaas" isn't always recognised. Confirm still catches a wrong guess, but only if the person notices.

**What this doesn't show.** No public recording of people splitting a bill was found. The real voices are Indian-accented speakers reading general sentences (Common Voice, CC0, accent labels self-reported and mostly male), so they test accents, not names or dishes. The split clips come from text-to-speech: two Hindi voices reading English written in Devanagari, and one US voice. They aren't real people. Background speech is mixed in at 10 dB. Real people saying real splits in the app is still the test that counts. The clips are never committed.

## What runs where

| | Pi | Render and Vercel | Supabase |
|---|---|---|---|
| Code | Should be `main`, once updated (section 1) | `main`: Gemini reads receipts here if `GEMINI_API_KEY` is set | All 8 migrations, as reported by the collaborator |
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
| **Supabase schema** | Done 2026-11-01 with a backup, as reported by the collaborator. All 8 migrations | Done |
| **Standby code** | Render and Vercel must run the same build as the Pi (S7.5). All three follow `main` once the Pi is updated | Pi update |
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

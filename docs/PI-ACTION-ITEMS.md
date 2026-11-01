# Pi: everything you need to do, in order

For the Pi developer, and any Claude session working on the Pi. Written 2026-11-01 against `main` @ `937ecfd`.
Companion docs: `docs/PI-STATUS.md` (where the Pi work stands), `deploy/pi/README.md` (how the stack runs),
`PLAN-PI-PRODUCTIONIZATION.md` (the plan; Appendix F is the master before-go-live list).

The repo is public. **Never put keys, passwords, the tailnet name or the Funnel URL in it.** Everything secret goes in
`deploy/pi/.env` on the Pi (git-ignored, `chmod 600`). Below, `<funnel-url>` means the Pi's public URL; ask the owner.

**Marks:** `[PI]` you do it on the Pi. `[OWNER]` only the owner can (dashboards, secrets, phones). `[CLAUDE]` a Claude session can do it with you.

---

## 0. What's new since you last pulled

Branch `main` now contains everything from `dev-pi`. You already have the Pi stack (P2/P3) and the M2 rehearsal; since then:

| Area | What changed | Touches the Pi? |
|---|---|---|
| Settlements | Record payments, partial payments, payment history, derived Settled/Pending | New migrations; client + API |
| Simplify debts | "Settle up" on a group; paying a suggestion is recorded as the chain of real debts | Client + API |
| **Receipt scanning (OCR)** | `/bill/new/scan`: photo -> model reads it -> user checks -> confirm. Model is swappable (Gemini default, or a local OpenAI-compatible model) | **Needs `GEMINI_API_KEY` in the Pi `.env`** |
| PWA | Installable app, offline shell, client-side failover (off unless both URLs are set) | Build args only |
| Security | Login rate limits (per IP + email), `helmet`, receipt-photo ownership check, idempotency keys on creating POSTs | Automatic |
| Database | Migrations **0004-0007**: idempotency keys, sync triggers, `deletion_log`, outbox, `system_state`, DEFERRABLE constraints | `migrate` service applies them |
| Timezone | Direct (non-pooler) connections now ask for a **UTC** session | Automatic |
| Sync / failover code | Forward sync agent, roles/fencing, controller, failback, integrity check | Code only; **off** until M4 |

---

## 1. Do now: update the Pi to `main` `[PI]`

```bash
cd ~/splittingwisdom && git pull origin main
cd deploy/pi
docker compose build            # ~10 min if dependencies changed
docker compose up -d            # reruns the migrate service first: applies 0004-0007
docker compose ps               # postgres + api healthy; migrate exited (0)
docker compose logs migrate     # should say migrations applied
./smoke.sh                      # QA-1; expect all checks pass (the script has grown to 54 checks)
```

- [ ] **PI-1** Pull `main`, rebuild, bring the stack up. Paste the `docker compose ps` output and the `smoke.sh` result into `docs/PI-STATUS.md`.
- [ ] **PI-2** Confirm migrations reached 0007: `docker compose exec postgres psql -U splittingwisdom -c "select count(*) from drizzle.__drizzle_migrations"` -> **8**.
- [ ] **PI-3** Confirm the database session is UTC: `docker compose exec postgres psql -U splittingwisdom -c "show timezone"` -> `UTC`. If not, add `-c timezone=UTC` to the postgres `command:` list in `docker-compose.yml`. (Timestamps are stored without a timezone and read back as UTC; a non-UTC database makes new bills look like "tomorrow" in the evening. Found locally on 2026-11-01.)
- [ ] **PI-4** Reboot test once more after the update (`sudo reboot`) and confirm the stack comes back healthy without a manual start.

If the `migrate` step fails, stop and read `docker compose logs migrate`. Do **not** edit or skip migrations by hand; send the log to the owner.

---

## 2. Turn on receipt scanning (OCR) `[PI]` + `[OWNER]`

OCR needs only an API key on the Pi. Receipts are stored locally (`STORAGE_DRIVER=local`, the `receipts` volume), so **no Supabase Storage is needed**.

- [ ] **PI-5** `[OWNER]` Send the Gemini key to the Pi developer privately (not in the repo, issues or chat logs you keep). Tell them if it's a new key; the one used during testing should be rotated at https://aistudio.google.com/apikey once testing is done.
- [ ] **PI-6** `[PI]` Edit `deploy/pi/.env`, set `GEMINI_API_KEY=<the key>`, then:
  ```bash
  cd deploy/pi && docker compose up -d api
  ```
  (`env_file: .env` passes it through; no compose change needed. Do **not** `build` just for this.)
- [ ] **PI-7** `[PI]` Optional model settings, all in the same `.env` (defaults are right; only change if scanning fails):

  | Variable | Default | Use |
  |---|---|---|
  | `GEMINI_MODEL` / `OCR_MODEL` | `gemini-3.5-flash` | Google retires models. `gemini-2.0-flash` is gone and 2.5 is closed to new users. `gemini-3.7-flash` timed out on real receipts; 3.8 was overloaded |
  | `OCR_FALLBACK_MODEL` | `gemini-3.5-flash-lite` | Tried once if the main model stays overloaded (503). `none` turns it off |
  | `OCR_TIMEOUT_MS` | `60000` | Raise for slower models |
  | `OCR_PROVIDER` / `OCR_BASE_URL` / `OCR_API_KEY` | `gemini` | Only to point at a local OpenAI-compatible model (Ollama, LM Studio, llama.cpp). Not needed for Gemini |

- [ ] **PI-8** `[PI]` Check the key and model from inside the container (never prints the key):
  ```bash
  docker compose exec api node -e "fetch('http://127.0.0.1:4000/api/health/db').then(r=>console.log('api ok', r.status))"
  docker compose logs api | grep -i "ocr" | tail
  ```
  A failure line reads `OCR extraction failed (gemini:<model>): <reason>`. Typical reasons: `404 ... no longer available` (change the model), `API key not valid` (bad key), `503 ... high demand` (Google busy; it retries and falls back by itself).
- [ ] **PI-9** `[OWNER]` Test on a phone against `<funnel-url>`: log in -> New Bill -> **Scan a receipt instead** -> take a photo. Expect "Reading receipt…" for ~5-15 s, then the review screen with the items. Confirm saves a bill with the photo attached ("View receipt" on the bill opens it).
  - Limits to know: JPG/PNG/WebP only (iPhone HEIC is **not** supported yet; set the camera to "Most Compatible"); 10 MB max (the app shrinks photos first); 10 scans per user per hour.
- [ ] **PI-10** `[PI]` Make sure the receipts volume is in your backups (P6.3): it holds the only copy of every photo. Receipts are **not** copied to the standby yet (plan S2.5), so they won't show during an outage.

---

## 3. Verify the update on the Pi (QA) `[PI]` + `[OWNER]`

- [ ] **PI-11** `[PI]` `./smoke.sh` passes (also proves a login survives restarting the whole stack).
- [ ] **PI-12** `[OWNER]` On Android **and** iPhone, against `<funnel-url>`, install the app and check:
  1. Still logged in after closing and reopening the app.
  2. Dashboard -> Settle with a demo person -> partial payment -> balance updates without a refresh.
  3. A group with 2+ debts -> **Settle up** -> **Simplified** -> pay the suggestion -> the **Direct** tab is empty afterwards.
  4. Dark mode: no white flash on reload.
  5. Scan a receipt (PI-9).
- [ ] **PI-13** `[PI]` Run the browser suite against the Pi if you can (needs Google Chrome on the machine running it): `E2E_PRIMARY_URL=<funnel-url> npx playwright test e2e/install-banner.spec.ts e2e/settlements.spec.ts e2e/simplify-debts.spec.ts e2e/scan-receipt.spec.ts`. The scan spec expects the fake model, so it will **not** pass against real Gemini; skip it there and use PI-9 instead.

---

## 4. Test the Pi -> backup -> Pi fallback (needs the owner) `[PI]` + `[OWNER]`

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

## 5. Before the Pi goes live (nothing here is optional)

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

## 6. Variable reference for `deploy/pi/.env`

| Variable | Needed now? | Notes |
|---|---|---|
| `POSTGRES_PASSWORD`, `SESSION_SECRET` | Yes (already set) | `openssl rand -hex 32` each |
| `GEMINI_API_KEY` | **Yes, for scanning** | Section 2 |
| `GEMINI_MODEL`, `OCR_*` | No | Defaults are good; see PI-7 |
| `VITE_PRIMARY_URL`, `VITE_STANDBY_URL` | Only for the fallback test | Build-time; rebuild after changing; both or neither |
| `APP_ROLE`, `SYNC_TARGET_DATABASE_URL`, `SYNC_TARGET_SSL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` | **No: leave off until F6** | Setting them connects the Pi to real Supabase |

Set by `docker-compose.yml` already (don't duplicate): `DATABASE_URL`, `DATABASE_SSL=off`, `DATABASE_POOLER=false`, `SERVE_CLIENT=true`, `STORAGE_DRIVER=local`, `RECEIPTS_DIR`.

---

## 7. Gotchas

- Changing `.env` -> `docker compose up -d` is enough. Changing code or `VITE_*` -> `docker compose build` first.
- `npm install <pkg> --workspace=...` removes a symlink `drizzle-kit` needs; run `node scripts/link-drizzle-orm.mjs` afterwards (fresh installs recreate it).
- Login cookies need HTTPS: log in through the Funnel URL, not `http://` or an SSH tunnel.
- Text accents in the client use `text-*-ink` classes (accessibility contrast); don't switch them back to `text-mint`/`text-coral`.
- If you add a Content-Security-Policy later: `client/public/theme-init.js` is a separate file so inline scripts can stay forbidden; fonts load from `fonts.googleapis.com` / `fonts.gstatic.com`.
- Don't create database migrations without telling the owner: numbering is shared across workstreams (0004-0007 are taken).
- Receipts: JPG/PNG/WebP only, 10 MB, 10 scans/user/hour.

## 8. What you are NOT waiting on anyone for

OCR, the review screen, settlements, simplify debts and the PWA are finished and tested; the owner runs them locally without the Pi. You're needed for: the Pi `.env` key (PI-6), the rebuilds (PI-1, PI-15), the crash/power tests (PI-17..20), and section 5.

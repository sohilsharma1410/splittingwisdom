# SplittingWisdom — Pi Productionization & Roadmap Plan

> **Audience:** the owner (Sohil) and any Claude Code session working on branch `dev-pi`.
> **Status:** PLAN — approved direction, **no implementation started**. Per `CLAUDE.md`, each milestone below needs a short step plan and an explicit "go" before code is written.
> **Last updated:** 2026-11-01 · **Branch:** `dev-pi` (cloned from `main` @ `f409ab3`)

---

## 0. How to read this document

| If you want… | Read |
|---|---|
| The one-page picture | §1 TL;DR, §3 Architecture |
| What must be done on the Pi | §4 Workstream **P** |
| How the backup/standby + sync works | §5 Workstream **S** |
| Remaining product features (settlements, OCR, voice, PWA) | §6 Workstream **D** |
| How we prove it works | §7 QA |
| What can go wrong | §8 Risks |
| Order of work + who does what | §9 Milestones |
| Decisions still open | §10 |

**Task IDs** (`P2.3`, `S4.1`, `D3.2`, `QA-7`) are stable references — use them in commits, PRs and chat.
**Checkboxes** `[ ]` are work items. `HUMAN` = only the owner can do it (physical access, dashboards, secrets). `CLAUDE` = a coding session can do it.

**Repo conventions that still apply (from `CLAUDE.md`, non-negotiable):** integer paise only; balances derived never stored; Zod on every input; auth → zod → authz → action → `{data}`/`{error}`; `npm run check` + tests + `npm run build` before any "done"; no new packages unless the plan says so (this plan explicitly approves the ones named in §6/D1, D4); ideas outside scope go to `BACKLOG.md`.

> Note: `PHASE-*.md` files and `README-START-HERE.md` live in the **parent folder** of the repo (`splittingWisdomFilesV1/`), not in git. Task **M0.5** copies them into `docs/phases/` so every session sees them.

---

## 1. TL;DR

- **Primary:** Raspberry Pi 5 (16 GB, 64 GB microSD) runs Postgres 17 + the Express API + the built web app (PWA), exposed publicly through **Tailscale Funnel** (`https://<pi>.<tailnet>.ts.net`). This is the URL users install the PWA from.
- **Standby:** existing **Supabase (Postgres) + Render (API) + Vercel (web app)**. Used only when the Pi is unreachable. Writes are allowed on the standby during an outage and are **synced back to the Pi** when it returns.
- **Failover is client-driven:** the installed PWA's service worker detects the Pi is down and navigates to the Vercel URL. **Vercel never connects to the Pi or the private tailnet** — it only talks to Render → Supabase, as today.
- **Standby is kept alive deliberately:** the previous keep-alive did **not** prevent Supabase pausing (it ran fine for 10 days, then failed every run from 2026-10-01). New design in §5/S1.
- **No new hardware** (owner decision). Power-cut risk on microSD is therefore mitigated by near-real-time replication + backups, not prevented — see §8 R1.
- **After infra:** settlements & debt simplification → OCR review screen → voice commands → PWA polish. The Capacitor APK is dropped in favour of the PWA.

### Decision log

| # | Decision | Date | Notes |
|---|---|---|---|
| D1 | Pi 5 is primary for DB + API + web app | 2026-11-01 | Postgres 17 to match Supabase 17.6 |
| D2 | Supabase + Render + Vercel = standby only | 2026-11-01 | Vercel is frontend only; **Render is the standby backend** |
| D3 | Entry point = Pi's Tailscale **Funnel** URL | 2026-11-01 | Public HTTPS, no Tailscale app needed for friends |
| D4 | Failover = PWA service worker redirects to Vercel URL | 2026-11-01 | Works for **installed/returning** users only (see §3.4 limitation) |
| D5 | Vercel must **not** reach the private network | 2026-11-01 | Vercel stays static + proxy to Render only |
| D6 | Standby accepts **writes**; sync back on recovery | 2026-11-01 | Needs schema changes (S5) |
| D7 | No new hardware (no UPS / SSD) | 2026-11-01 | Accepts residual risk R1 |
| D8 | Voice = browser speech-to-text + Gemini parse, confirm-before-save | 2026-11-01 | Fallback: record audio → Gemini (see D4/V-arch) |
| D9 | PWA replaces Capacitor APK (Phase 6 §3 dropped) | 2026-11-01 | Assumption — owner may veto |
| D10 | Roadmap order after infra: settlements → OCR → voice | 2026-11-01 | Assumption — owner may veto |
| D11 | Continuous **one-way** copy Pi → Supabase is kept as the backup (Supabase never accepts writes in normal operation; Pi stays sole source of truth) | 2026-11-01 | Owner confirmed: data not highly confidential at this stage |
| D12 | Pi ships **all** logs (success + failure) to Supabase, event-based micro-batched; **no deletion for the first ≥ 14 days**, retention module built later only if needed | 2026-11-01 | See P8; free-tier limits evaluated there |

---

## 2. Current state (verified 2026-11-01)

| Item | Fact |
|---|---|
| Stack | React 18 + TS + Vite + Tailwind + Radix + TanStack Query + wouter · Express + TS · Drizzle + Postgres · `/shared` (schema, Zod, balance lib) |
| Hosting today | Vercel (client, `splittingwisdom-client.vercel.app`) → rewrites `/api/*` to Render (`splittingwisdom-api.onrender.com`) → Supabase Postgres (pooler) |
| Data | 25 users · 11 groups · 11 bills · 0 settlements · 38 sessions · **11 MB** · Postgres 17.6 |
| Phases | 1–4 live. Phase 5: upload/storage + Gemini extract **endpoint** built; **review-screen UI not built**. Phase 6 (settlements etc.) **not started** (no settlements route; Settle buttons disabled). |
| Login fixes shipped | case-insensitive email, show/hide password, change-password, same-origin `/api` proxy (cookie fix for mobile), `/api/health/db` |
| Quality gates | `npm run check` ✅ · 57 money tests ✅ · builds ✅ · `npm audit` ⚠ 5 prod-dep vulns (1 critical `proxy-addr`, 3 high: `body-parser`, `multer`, `zod`; 1 moderate `qs`) — all have fixes |
| Incidents | Supabase auto-paused twice (≈Sep 8 and ≈Oct 1). GitHub keep-alive workflow: runs 1–6 ✅, runs 7–22 ❌. Root cause: direct Postgres queries do **not** count as Supabase activity (inferred; see S1.1 to verify). |
| PWA | **Not a PWA yet** — no manifest, no service worker, no icons. |
| Hard-coded things that break on a Pi | `server/src/session.ts` forces `ssl: { rejectUnauthorized: false }` (fails against a non-SSL local Postgres); receipts use Supabase Storage only; no static-file serving in Express; `CLIENT_ORIGIN`/CORS assume two origins. |
| Receipts | Gemini model in code is `gemini-2.0-flash` — **may be retired**; verify/make configurable (D3.1). |

---

## 3. Target architecture

### 3.1 Diagram

```
                           (1) normal operation
 ┌──────────────┐   https://<pi>.<tailnet>.ts.net    ┌────────────────────────────────┐
 │  Phone PWA   │ ─────────────────────────────────▶ │ Tailscale Funnel (public 443)  │
 │ (installed   │                                    └───────────────┬────────────────┘
 │  from Pi URL)│                                                    │ localhost
 └──────┬───────┘                                    ┌───────────────▼────────────────┐
        │                                            │ Raspberry Pi 5 (PRIMARY)       │
        │                                            │  • Express API + built web app │
        │                                            │  • Postgres 17 (local volume)  │
        │                                            │  • receipts/ on local disk     │
        │                                            │  • sync-agent (Pi → Supabase)  │
        │                                            └───────────────┬────────────────┘
        │                                                            │ continuous forward sync
        │ (2) Pi unreachable → service worker                        ▼
        │     navigates to Vercel URL                ┌────────────────────────────────┐
        │                                            │ Supabase Postgres (STANDBY DB) │
        ▼                                            └───────────────▲────────────────┘
 ┌──────────────┐  /api/* rewrite   ┌─────────────┐                 │
 │ Vercel (web) │ ────────────────▶ │ Render (API)│ ────────────────┘
 └──────────────┘                   │ STANDBY +   │   also runs the CONTROLLER (watchdog,
                                    │ CONTROLLER  │   role flag, failback sync)
                                    └─────────────┘
```

### 3.2 Components & roles

| Component | Normal | During Pi outage | After Pi returns |
|---|---|---|---|
| Pi API + Postgres | read/write (primary) | down | `recovering` → pulls standby changes → primary again |
| Funnel URL | serves PWA + API | Tailscale error page | serves again |
| Vercel + Render + Supabase | warm standby, **receives forward sync**, read-write **disabled** | **read-write enabled** | read-only during cutover, then disabled for writes |
| Controller (runs on Render) | probes Pi every 30 s | flips role flag to `standby-active` after 3 failures | runs failback, flips to `primary-active` |
| Role flag | `primary-active` | `standby-active` | `primary-active` |

### 3.3 Why the controller lives on Render (not the Pi)
The Pi cannot detect or announce its own death. The standby side must be the observer. Render is kept warm (S1.2) so it can fill this role. If Render is also down, there is nothing to fail over to — acceptable for a friend-group app; alerting covers it.

### 3.4 Known limitations of the chosen design (accepted by owner)
1. **First-time / non-installed visitors** who open the Pi URL while the Pi is down see Tailscale's error page — no code of ours can run. **Mitigation:** share *both* links ("main app / backup app") and tell people to install the PWA once.
2. **Redirect leaves standalone mode:** navigating from the installed PWA to another origin opens a browser overlay/tab, not the standalone app.
3. **Different origin ⇒ separate cookies/localStorage:** users must **log in again** on the standby (and again after failback). Optional mitigation: one-time handoff token (S8).
4. A Pi that is up but unreachable from *some* networks can cause split-brain; fencing in S3 limits it.
5. The Pi's Funnel URL is **publicly reachable** (same exposure as Render today). Hardening in P7.

---

## 4. Workstream P — Pi as primary

> Goal: everything that works on Vercel/Render/Supabase today works, unchanged, on the Pi — then survives reboots and power cuts.

### P0 — Prerequisites (HUMAN)
- [ ] P0.1 Confirm Pi state: OS installed? hostname? SSH works? (default plan assumes a fresh **Raspberry Pi OS Lite 64-bit (Bookworm)**).
- [ ] P0.2 Tailscale account exists; decide tailnet name. Enable **HTTPS** and **Funnel** for the tailnet (admin console → DNS → HTTPS; Access controls → `nodeAttrs` `funnel`).
- [ ] P0.3 Use a **high-endurance microSD** (A2/“endurance” class) if possible — cheapest risk reduction without new hardware categories.
- [ ] P0.4 Stable power: plug into a good PSU (official 27 W), not a flaky charger/strip.
- [ ] P0.5 Decide notification channel for alerts (email via GitHub Actions already exists; optional: ntfy.sh/Telegram).

### P1 — OS setup & hardening (HUMAN with CLAUDE-provided script)
- [ ] P1.1 Flash OS, enable SSH key auth only, disable password login, set timezone `Asia/Kolkata`, enable **NTP** (time skew breaks sync ordering).
- [ ] P1.2 `ufw`: deny all inbound except SSH from LAN/Tailscale (Funnel does not need open inbound ports).
- [ ] P1.3 `unattended-upgrades` for security patches; **no auto-reboot during peak** (schedule 04:00).
- [ ] P1.4 Reduce SD wear: `log2ram` or `journald` Storage=volatile + persistent logs only for errors; `noatime` mount; disable swap or use `zram`.
- [ ] P1.5 Enable the **hardware watchdog** (`RuntimeWatchdogSec`) so a hung Pi reboots itself.
- [ ] P1.6 Install Docker Engine + Compose plugin (arm64).

### P2 — Containerised stack (CLAUDE)
File layout (new, on `dev-pi`): `deploy/pi/docker-compose.yml`, `deploy/pi/.env.example`, `deploy/pi/Dockerfile.api`, `deploy/pi/README.md`.

- [ ] P2.1 `postgres:17` container; data on a named volume on the SD card; settings: `fsync=on`, `synchronous_commit=on`, `full_page_writes=on`, `wal_level=logical` (needed if S2 chooses logical replication), `max_wal_size` modest, `shared_buffers=1GB`, `max_connections=50`.
- [ ] P2.2 `api` container: multi-stage build of `shared` → `server` → `client`, Node 22 on arm64. **Express serves the built client** (`client/dist`) with SPA fallback, so one origin serves PWA + API (also removes CORS need on the Pi).
- [ ] P2.3 `tailscale` container (or host install) with `TS_AUTHKEY` (reusable, **tagged**, key expiry **disabled** for this node), `tailscale serve` → `localhost:4000`, `tailscale funnel 443 on`.
- [ ] P2.4 `restart: unless-stopped` on every service; `depends_on` with health checks; systemd unit to `docker compose up -d` on boot.
- [ ] P2.5 `/api/health` (liveness, no DB), `/api/health/db` (query), new `/api/health/role` returning `{role, active, lastSyncAt, lagSeconds}`.
- [ ] P2.6 Graceful shutdown (SIGTERM → stop accepting → drain → close pool) so `docker stop`/shutdown never kills mid-transaction.

### P3 — Code changes required for the Pi (CLAUDE)
- [ ] P3.1 **DB TLS config via env.** `session.ts` currently hard-codes `ssl:{rejectUnauthorized:false}`. Introduce `DATABASE_SSL=on|off` (Pi=off for local socket/host network; Supabase=on). Same for `db.ts`. Keep `prepare:false` only when `DATABASE_POOLER=true` (Supabase pooler); enable prepared statements locally.
- [ ] P3.2 **Storage driver abstraction** (`server/src/lib/storage.ts`): `STORAGE_DRIVER=local|supabase`. `local` writes under `RECEIPTS_DIR` (volume), serves via **authenticated** route streaming the file (no public path; keeps "private + short-lived access" rule via signed, expiring route tokens). Same function signatures (`uploadReceiptImage`, `getReceiptSignedUrl`, `deleteReceiptImage`, `listReceiptImagePaths`).
- [ ] P3.3 **Static client serving + SPA fallback** in Express (only when `SERVE_CLIENT=true`).
- [ ] P3.4 **Role awareness:** env `APP_ROLE=primary|standby`; middleware `requireWritable` on every mutating route returning `503 {error:{message:"Read-only: backup mode switching"}}` when the node is not currently writable (S3).
- [ ] P3.5 Cookie/proxy settings verified behind Funnel: `trust proxy`, `secure` cookie, `sameSite=lax`. Same `SESSION_SECRET` on Pi and Render (so replicated session rows validate).
- [ ] P3.6 `.env.example` per role (see Appendix B). No secrets committed.
- [ ] P3.7 Dependency hardening (also D0): `npm audit fix`, re-run tests.

### P4 — Data migration: Supabase → Pi (HUMAN-run, CLAUDE-scripted)
Scale is tiny (11 MB), so use dump/restore with a short freeze.

- [ ] P4.1 **Rehearsal first** (no users affected): `pg_dump` from Supabase → restore into a scratch Postgres 17 locally/on Pi → run app against it → compare counts + run balance-invariant check (QA-4).
- [ ] P4.2 Schema source of truth = Drizzle migrations (`server/drizzle/*`). On Pi: run `npm run db:migrate` on empty DB, then **data-only** restore, so the `__drizzle_migrations` journal stays correct.
- [ ] P4.3 Dump command (public schema only; exclude Supabase internals):
  ```bash
  pg_dump "$SUPABASE_DIRECT_URL" --schema=public --data-only --no-owner --no-privileges \
          --exclude-table=public.session -Fc -f splitwisdom-data.dump
  ```
  (session table optional — users simply re-login; **include** it if you want sessions preserved for the cutover.)
- [ ] P4.4 After restore: `SELECT setval(pg_get_serial_sequence('<table>','id'), (SELECT COALESCE(MAX(id),1) FROM <table>))` for every serial table.
- [ ] P4.5 **Cutover runbook** (≈10 min): announce → set Render to read-only → final dump → restore → verify counts/invariants → start forward sync (S2) → point Funnel URL live → smoke test (QA-1) → re-enable standby role `standby-idle`.
- [ ] P4.6 **Rollback:** if verification fails, leave users on Vercel/Render/Supabase (untouched); nothing on the Pi is authoritative until P4.5 completes.
- [ ] P4.7 Receipts: none are in production yet (Part 0 never completed) — if any exist, copy bucket → `RECEIPTS_DIR` (`rclone`/`supabase storage` CLI).
- [ ] P4.8 "Other data required to run locally": env files, `SESSION_SECRET` (copy from Render), Gemini key, Tailscale auth key, drizzle migrations — all listed in Appendix B.

### P5 — Tailscale & PWA exposure (HUMAN + CLAUDE)
- [ ] P5.1 Install/auth Tailscale on the Pi with a tag (e.g. `tag:server`); **disable key expiry** for the node.
- [ ] P5.2 ACL: only the owner's devices get SSH/admin; Funnel exposes **only** `https:443 → localhost:4000`.
- [ ] P5.3 Verify `https://<pi>.<tailnet>.ts.net` serves the app with a valid cert, installs as PWA on Android Chrome and iOS Safari (needs D1).
- [ ] P5.4 Document Funnel constraints: ports 443/8443/10000 only; bandwidth is limited (undisclosed) — fine at friend-group scale; monitor.
- [ ] P5.5 Document **what the public can reach:** only the app on that port. The tailnet's other devices/ports are not exposed; Vercel has no path to them (D5).

### P6 — Power-loss & SD-card resilience (no new hardware)
Honest framing: **cannot be eliminated, only bounded.** Bound = replication lag (target ≤ 60 s) + last good backup.

- [ ] P6.1 Postgres durability settings per P2.1 (never `fsync=off`).
- [ ] P6.2 Filesystem: ext4 with journaling and default mount options (plus `noatime`); avoid any tweak that trades durability for speed.
- [ ] P6.3 **Backups (3 layers):** (a) continuous forward sync to Supabase (S2); (b) nightly `pg_dump -Fc` to the Pi's second path + uploaded to Supabase Storage (kept 14 days); (c) weekly dump to an **offsite** location the owner controls (e.g. personal Google Drive via `rclone`).
- [ ] P6.4 **Startup self-check** (`deploy/pi/selfcheck.sh` on boot): Postgres recovered? `pg_isready`; `SELECT count(*)` on core tables; compare max IDs/`lastSyncAt` with Supabase; if Pi DB is *behind or corrupt* → mark `primary-unhealthy`, **do not accept writes**, alert owner, offer one-command **restore-from-Supabase** (`deploy/pi/restore-from-standby.sh`).
- [ ] P6.5 Auto-start order after power returns: network → Tailscale → Postgres → sync-agent → API; API starts **read-only** until self-check passes.
- [ ] P6.6 Monthly **SD health**: `dmesg` I/O errors, `smartctl` n/a for SD — track write volume; replace card yearly; keep a **cloned spare SD image** (`dd` after each milestone).
- [ ] P6.7 Drill: simulated power cut (`echo b > /proc/sysrq-trigger` while writing) ×10, verify recovery (QA-5).

### P7 — Observability & security hardening
- [ ] P7.1 Alerts: workflow failures (exists, GitHub email) + controller alerts (Pi down > 2 min, sync lag > 5 min, standby active, failback complete) via chosen channel (P0.5).
- [ ] P7.2 Rate-limit **unauthenticated** routes (login/register/forgot-password) by IP (current limiter only keys on session user). Add `helmet`.
- [ ] P7.3 Structured logs, no PII/password hashes/tokens in logs.
- [ ] P7.4 Secrets: `.env` mode 600; never in git; rotate `SESSION_SECRET` only with a planned re-login.
- [ ] P7.5 Dependency/OS update cadence documented (monthly).

### P8 — Log pipeline: Pi → Supabase (event-based)

**Purpose:** keep a durable, queryable history of everything that happened (successes and failures) so we can analyse what went wrong — including after the Pi's SD card dies.

**Supabase free-tier evaluation (limits as known at time of writing — re-verify on Supabase's pricing page before M5):**

| Limit | Free tier | Impact on logging | Verdict |
|---|---|---|---|
| Database size | ~500 MB per project; exceeding it puts the project in **read-only** mode | Logs share the DB with real data (now 11 MB) and the standby. A runaway log table could make the **standby read-only** — the worst outcome | **Real risk → needs size monitoring + a non-deleting emergency brake (below); retention module deferred** |
| Row count / write rate | No hard row cap or per-insert charge | Per-event single INSERTs are chatty and eat pooler connections | OK if **micro-batched** |
| Connections | Small pooled connection budget | One long-lived sink connection only | OK |
| Egress | ~5 GB/month | Pi → Supabase is ingress; only our own log queries count | OK |
| Inactivity pause | ~1 week | Constant log writes are *DB* activity, which did **not** prevent the Oct-1 pause; REST-API activity may | Don't rely on it; S1 pings still required |
| Built-in Log Explorer | Short retention on free tier, Supabase's own logs only | Not a substitute for app logs | We store our own |
| `pg_cron` | Available as an extension | Used for retention purge | OK (verify enabled) |

**Volume estimate:** ~25 users, say 5k API events/day + ~1k system events/day ≈ 6k rows/day × ~0.6 KB (row + indexes) ≈ **3.6 MB/day ≈ 110 MB/month** if nothing is purged → without retention the 500 MB cap would be hit in ~4 months. **Nothing is deleted for at least 14 days** (≈ 50 MB by then, safe); retention is decided from real measured growth afterwards (P8.8).

**Conclusion:** no blocker, **provided** (a) micro-batching, (b) size monitoring with alerts + emergency brake, and a retention module before ~day 60 if growth warrants it, (c) log failures never block or slow the app, (d) no sensitive data in logs.

Tasks:
- [ ] P8.1 **Structured logging** in server (`pino`, new dep approved by this plan): JSON with `ts, level, event, requestId, userId (id only), route, method, status, durationMs, role, epoch, err{message, stack≤2KB}`. Request log middleware emits one event per request (success *and* failure). Levels: debug/info/warn/error/fatal.
- [ ] P8.2 **Event sources:** API requests; sync-agent (batch sent/failed, lag); controller (probe results, role flips, failback steps); Postgres errors; app boot (`boot_id`, previous shutdown clean/**unclean** — key signal for power cuts); self-check results (P6.4); Tailscale/Funnel status changes; Docker container restarts; client errors from the PWA (`POST /api/logs/client`, authenticated, rate-limited, size-capped) including failover events (S7).
- [ ] P8.3 **Never log:** passwords, hashes, session ids/cookies, auth/handoff tokens, API keys, full request/response bodies, receipt images or extracted text, raw voice transcripts. Redaction helper + unit test that fails if forbidden keys appear (QA-16).
- [ ] P8.4 **Transport (event-based, micro-batched):** each log event is enqueued the moment it is created; a sink flushes **every ≤ 1 s or 50 events**, and **immediately for `error`/`fatal`**. One batched `INSERT … ` per flush over a single pooled connection. Idempotent via `(source, boot_id, seq)` unique key so retries never duplicate.
- [ ] P8.5 **Never block the app:** bounded in-memory queue (e.g. 5,000 events, drop oldest `debug`/`info` first, count drops). Sink errors are swallowed and retried with backoff; they must not throw into request handling.
- [ ] P8.6 **When Supabase/internet is unreachable:** spill to a local JSONL spool on the Pi (append-only, size-capped ~50 MB, `fsync` on error-level lines only to limit SD wear); drained in order when connectivity returns. Spool also protects error logs across a crash.
- [ ] P8.7 **Supabase schema** (separate `ops` schema, RLS enabled, no policies for `anon`/`authenticated`; only the server's service credentials write): `ops.app_logs(id bigserial pk, ts timestamptz, source text, boot_id text, seq bigint, level text, event text, request_id text, user_id int, route text, status int, duration_ms int, data jsonb, unique(source, boot_id, seq))`; indexes **only** on `(ts)` and `(level, ts)` to keep size low.
- [ ] P8.8 **Retention — deferred by owner decision.** **No log is deleted for at least 14 days.** During that window we only measure (daily size job writes `log_size_mb`, rows/day and per-level counts into the logs themselves). After ≥ 14 days, review the numbers together and **then** build the retention module only if required (candidate policy, *not active*: debug 3 d, info 14–30 d, warn 60 d, error/fatal 180 d via `pg_cron`). **Safeguards that do not delete data:** alert when `ops` > 150 MB or total DB > 350 MB; **emergency brake** at total DB > 450 MB: the sink stops shipping `debug`/`info` to Supabase (keeps spooling them on the Pi, P8.6) so the standby can never be pushed into read-only by logs; shipping resumes after the owner frees space or approves retention.
- [ ] P8.9 **Render/standby also logs to the same table** (`source='render'`/`'controller'`) so the outage period is fully covered even though the Pi is down; Pi's own last moments arrive from its spool after recovery.
- [ ] P8.10 **Analysis views** (SQL, in repo `docs/ops-queries.sql`): errors by route/day, p95 latency, failovers with timeline (probe fails → role flip → failback), unclean-shutdown list, sync lag over time, top failing users (ids).
- [ ] P8.11 Local-only copy: Postgres/Docker logs also kept on Pi via journald (volatile + errors persisted, per P1.4) as a last resort.
- Acceptance: disconnect internet for 10 min while generating traffic → after reconnect, **zero lost and zero duplicate** events (except documented drops); error events visible in Supabase < 5 s; size-growth report available after 14 days to decide on retention; emergency brake tested.

---

## 5. Workstream S — Standby, sync, failover/failback

### S1 — Keep the standby genuinely alive
- [ ] S1.1 **Verify the pause rule** instead of assuming: ping Supabase's **REST/API** (`GET {SUPABASE_URL}/rest/v1/` with anon key) *and* a DB query; track for ≥ 10 days after restore. (Hypothesis: only API/dashboard traffic counts — direct pooler queries did not prevent the Oct 1 pause.) HUMAN: add `SUPABASE_URL` + `SUPABASE_ANON_KEY` as GitHub Actions secrets.
- [ ] S1.2 **Render keep-warm:** ping `/api/health` every **10 min** (free instance sleeps after ~15 min; cold start observed ≈ 43 s). Budget check: 750 free instance-hours/month ≈ one always-on service — OK for a single service. GitHub Actions cron minimum is 5 min and is **best-effort/delayed** → add a second, independent pinger (e.g. UptimeRobot / cron-job.org free tier) so one failing doesn't strand us.
- [ ] S1.3 **Vercel:** static hosting does not sleep; keep a daily `GET /` + `GET /api/health` (through the rewrite) in the same workflow for end-to-end coverage.
- [ ] S1.4 GitHub scheduled workflows run **only from the default branch (`main`)** and are disabled after 60 days of repo inactivity → merge keep-alive changes to `main` (M0) and add a monthly no-op commit/“workflow_dispatch” reminder.
- [ ] S1.5 Failure → alert, and a runbook line: "Supabase paused → Dashboard → Restore (≤ ~90 days after pause)".
- [ ] S1.6 The forward sync itself (S2) should also call the Supabase API periodically, so activity is real even if the cron misses.

### S2 — Forward sync: Pi → Supabase (continuous, one-way)
Tables: `users, groups, group_members, bills, bill_items, item_assignments, settlements, session` (+ receipts files).

- [ ] S2.1 **Spike (time-boxed 1 day):** can Supabase (hosted) act as a **logical-replication subscriber**? If yes, use native logical replication (publication on Pi, subscription on Supabase) — simplest, lowest lag. Constraint: hosted Supabase limits superuser features; verify before committing.
- [ ] S2.2 **Fallback design (likely):** *outbox + sync-agent.* Triggers on every synced table append rows to `sync_outbox(id, table, pk, op, payload, at)`; a small `sync-agent` (Node, runs on the Pi) ships batches to Supabase over its pooler URL in a single transaction, idempotently (`INSERT … ON CONFLICT (id) DO UPDATE` guarded by `updated_at`), then marks them sent. Retries with backoff; survives restarts (outbox is durable).
- [ ] S2.3 Lag metric `lagSeconds` exposed at `/api/health/role`; alert at > 300 s.
- [ ] S2.4 Initial full copy = P4 restore of Supabase is already identical at cutover; thereafter incremental.
- [ ] S2.5 Receipts: sync-agent uploads new files to a **private** Supabase Storage bucket and records the path.
- [ ] S2.6 **Decision gate:** after S2.1 spike, owner approves approach before S3+.

### S3 — Failure detection, roles, fencing
- [ ] S3.1 Table `system_state(id=1, active_primary text check in ('pi','standby'), epoch int, updated_at)` stored in **Supabase** (the always-reachable side).
- [ ] S3.2 **Controller** (Render process): every 30 s `GET <pi-url>/api/health/db` with 5 s timeout. **3 consecutive failures ⇒** `active_primary='standby'`, `epoch++`, alert. Standby API now allows writes (P3.4).
- [ ] S3.3 **Fencing:** every write on either node first confirms `active_primary` equals its own identity (cached ≤ 10 s). A Pi that comes back and still thinks it's primary **must refuse writes** until it has read the flag and completed failback (prevents split-brain).
- [ ] S3.4 **Hysteresis:** return to Pi only after ≥ 5 consecutive healthy probes **and** completed failback (S4). Never auto-flap.
- [ ] S3.5 Edge case — Pi healthy but unreachable only from Render: controller probes Pi via Funnel from Render *and* the Pi pushes a heartbeat row to Supabase every 15 s; failover requires **both** probes failing (reduces false failovers).

### S4 — Failback: standby → Pi
1. [ ] S4.1 Pi boots → `role=recovering`, API **read-only**, self-check (P6.4).
2. [ ] S4.2 Controller sees Pi healthy ×5 → sets `active_primary='cutover'` (standby becomes **read-only**; ~seconds).
3. [ ] S4.3 **Reverse sync**: Pi pulls all standby changes with `updated_at`/`epoch` newer than its last-synced watermark (standby-originated rows are marked `origin='standby'`), applies in dependency order (users → groups → members → bills → items → assignments → settlements), idempotent.
4. [ ] S4.4 **Verify:** row counts per table, per-bill sum(shares) = bill total (money invariant), per-pair balances equal on both sides (QA-4). Mismatch ⇒ abort, stay on standby, alert.
5. [ ] S4.5 Pi bumps sequences above max id; controller sets `active_primary='pi'`, `epoch++`; standby returns to `idle`; forward sync resumes.
6. [ ] S4.6 Clients: PWA on Vercel shows banner "Main server is back — switch" (S7). No forced mid-edit redirect.

### S5 — Schema changes needed for safe two-sided writes
New migration(s) (CLAUDE; reviewed by owner before running on any real DB):
- [ ] S5.1 **IDs:** standby sequences start at `1_000_000_000` (Pi stays low) ⇒ no ID collisions across sides; Pi imports standby rows with their IDs; bump sequences afterwards. (Chosen over UUIDs to avoid rewriting every FK/route.)
- [ ] S5.2 `updated_at timestamptz not null default now()` + trigger on `users, groups, group_members, bills, bill_items, item_assignments, settlements` (bills already has `lastEditedAt`; keep it, add the generic one).
- [ ] S5.3 **Deletes:** add `deleted_at` (soft delete) **or** a `deletion_log(table, pk, at, origin)` table fed by triggers. Preference: deletion log (zero change to existing queries). Reverse sync replays deletes.
- [ ] S5.4 `origin text default 'pi'` on synced tables (`'standby'` when written by standby role).
- [ ] S5.5 `sync_conflicts` table: any row changed on both sides since last sync is resolved **last-writer-wins by `updated_at`** and logged for owner review. Expected to be near-empty because only one side is writable at a time.
- [ ] S5.6 Update Drizzle schema + Zod in `/shared`; **money tests must stay green**; add sync tests (QA-3).

### S6 — Idempotency
- [ ] S6.1 All creating POSTs (`/bills`, `/settlements`, group/member adds) accept `Idempotency-Key`; server stores key→response for 24 h. Client generates a key per user action. Prevents duplicates when a request succeeds on the Pi but the response is lost and the user retries on the standby. (Already required for settlements by Phase 6 §1.)

### S7 — Client failover behaviour (service worker + app)
- [ ] S7.1 Service worker (D1) caches the app shell; on launch it probes `GET /api/health` on its own origin (timeout 4 s).
- [ ] S7.2 On Pi origin: probe fails 2× ⇒ show "Main server unreachable — opening backup" and `location.replace(VERCEL_URL + currentPath)`. Remember choice in `localStorage` (`lastOrigin`).
- [ ] S7.3 On Vercel origin: background probe of Pi Funnel `/api/health` every 60 s (CORS-enabled health route, no credentials). When healthy ≥ 3×: non-blocking banner "Main server is back" → user taps to switch (auto-switch only on cold app launch, never mid-form).
- [ ] S7.4 Banner on standby: "Backup mode — changes will be copied back automatically."
- [ ] S7.5 Both origins must run the **same client build version**; version mismatch banner prompts refresh.

### S8 — (Optional) session handoff to avoid re-login
- [ ] S8.1 Pi issues a single-use, 60 s, HMAC-signed handoff token on the redirect URL **fragment** (`#h=…`); Vercel/Render exchanges it at `POST /api/auth/handoff` for a session (sessions are replicated and `SESSION_SECRET` is shared). Security review required (token in URL, replay, logging). Ship only if re-login proves annoying in drills.

---

## 6. Workstream D — Product development roadmap

> Order (D10): **D0 → D1 → D2 → D3 → D4 → D5.** D1 can start in parallel with P-work since it only needs the repo.

### D0 — Hygiene (before anything else)
- [x] D0.1 `npm audit fix` for prod deps (`proxy-addr`, `body-parser`, `multer`, `zod`, `qs`); rerun checks/tests/build.
- [x] D0.2 Login/register IP rate-limit + `helmet` (P7.2).
- [x] D0.3 Move `PHASE-*.md`, `README-START-HERE.md` into `docs/phases/` (tracked).
- [x] D0.4 Triage the Bug Report sheet (re-checked 2026-11-01: still only the example row) (`SplittingWisdom Bug Reports`, Google Sheets) — currently only the example row; process each row as `BUG-<n>` with a regression test.
- [x] D0.5 Password reset: **blocked on email provider decision** (deferred by owner). Interim: owner-run `scripts/reset-password.ts <email>` + documented.

### D1 — PWA foundation (needed for failover, install, voice, camera)
New dependency approved by this plan: `vite-plugin-pwa` (Workbox) — or hand-written service worker if preferred.
- [x] D1.1 `manifest.webmanifest` (name, short_name, `display: standalone`, theme/background colors from design tokens, `start_url=/`, scope `/`), icons 192/512 + maskable, Apple touch icon, `<meta name="theme-color">`.
- [x] D1.2 Service worker: precache app shell; **never cache `/api/*` responses** (money data stays live; cache only GET `/api/health`); update flow ("New version — refresh").
- [x] D1.3 Install UX: Android `beforeinstallprompt` button; iOS instructions ("Share → Add to Home Screen") shown once.
- [x] D1.4 Failover logic S7.
- [x] D1.5 Offline state: friendly screen when both origins unreachable.
- [ ] D1.6 Verify camera capture + file input inside installed PWA on Android and iOS.
- [ ] Acceptance: Lighthouse PWA/installability pass; installs from Pi URL on Android Chrome + iOS Safari; shell loads offline; failover redirect works in drill QA-6.

### D2 — Phase 6 (minus APK): settlements, debt simplification, onboarding
Source of truth for scope/acceptance: `PHASE-6-settle-ship.md` §1, §1a, §2, §4. **Drop §3 (Capacitor/APK)** per D9; keep "what's new" notice via PWA update flow instead.
- [ ] D2.1 `POST /api/settlements` (+ list), Zod, authz (both parties in group), paise, **server-side cap at outstanding**, idempotency key (S6), `requireWritable`.
- [x] D2.2 Settlement dialog (pre-filled outstanding, hard-capped, note, date), enable Settle buttons (dashboard, balances, balance detail), query invalidation on all surfaces.
- [x] D2.3 Balance detail: settlement history interleaved into explanation; Activity "Settled/Pending" logic.
- [x] D2.4 `simplifyDebts()` in `/shared/lib` + vitest (cycle of 3+ strictly fewer txns; total moved unchanged; already-minimal unchanged; zero balances → none; deterministic tie-break by member id). "Simplify debts" view on Group + Balances pages; suggestion only, ledger untouched.
- [x] D2.5 Onboarding (3 steps, skippable, once) + motion pass (respect `prefers-reduced-motion`) + SPEC §17 states sweep + a11y sweep.
- [x] D2.6 Extend balance tests for settlements: full, partial, then new bill, over-settlement rejected server-side.
- [ ] Acceptance: Phase 6 checklist items for settlements/simplification (₹500 of ₹1,300 → ₹800 everywhere; ₹5,000 vs ₹800 rejected via direct API call; double-tap = one settlement).

### D3 — Phase 5 completion: OCR review screen
Source: `PHASE-5-ocr.md` §3 and `PLAN` notes in repo history (Checkpoint C).
- [ ] D3.1 **Pre-flight:** make model configurable `GEMINI_MODEL`; confirm the model still exists (current default `gemini-2.0-flash` may be retired) and pick the current free-tier Flash model; add a startup log of the model in use.
- [ ] D3.2 With Pi: `STORAGE_DRIVER=local` (P3.2) — **no Supabase bucket needed**; Part 0 reduces to `GEMINI_API_KEY`. HUMAN: provide key; set in Pi + Render env.
- [ ] D3.3 **5-receipt extraction test** (crisp, crumpled, long grocery, handwritten, dim) via `curl` to `POST /api/bills/extract` (field `image`); record accuracy table (items, prices, total, `totalsMismatch`); owner reviews before UI work.
- [ ] D3.4 iOS photos: test `<input accept="image/jpeg,image/png,image/webp" capture>` on iPhone (HEIC→JPEG conversion behaviour); decide whether HEIC support is needed now that iOS PWA users exist.
- [ ] D3.5 Review screen at route `/bill/new/scan`: image + editable extraction; low-confidence fields flagged (icon + amber outline + "please check", never colour alone) and listed in "Needs review"; item add/edit/delete/reorder; charges editable; **totals-mismatch banner** with delta and "use items sum" one-tap; group/payer/date selectors; **Confirm bill** → `POST /api/bills` with `receiptImageUrl`, defaults to equal split among selected people (existing assignment UI) → `/bill/:id`.
- [ ] D3.6 Entry point: "New Bill" → chooser **Scan a receipt / Enter manually** (manual flow unchanged).
- [ ] D3.7 Failure paths: extraction failed / rate-limited ⇒ same screen, empty items, image shown, "Couldn't read this receipt — add items manually". Orphan image cleanup script runs weekly on Pi (cron/systemd timer).
- [ ] D3.8 Gemini free-tier quota: handle 429 gracefully; show manual fallback.
- [ ] Acceptance: `PHASE-5-ocr.md` "Definition of done" list.

### D4 — Voice commands (new)
**Goal:** speak naturally to add/assign items; always **confirm before saving**.

**Use cases (priority order)**
| ID | Utterance (examples, incl. Hinglish) | Result |
|---|---|---|
| V1 | "Give the pizza to Ravi and split the fries between me and Asha" / "Pizza Ravi ko do, fries main aur Asha mein baant do" | proposed item→people assignments on the open bill |
| V2 | "Add paneer tikka two hundred fifty, two naan eighty each" | proposed new items (name, price in paise, qty) |
| V3 | "Everyone except Karan shares the drinks" | assignment using group roster minus exclusion |
| V4 | "I paid Ravi five hundred" | proposed **settlement** (D2) — confirm dialog, capped |
| V5 (optional) | "How much do I owe Asha?" | spoken/text answer from derived balances (read-only) |

**Architecture (D8)**
```
Mic → SpeechRecognition (browser)  ──text──┐
        └─ fallback: MediaRecorder audio ──┤→ POST /api/voice/parse
                                           │     { transcript | audio, context:{groupMembers, billItems, currency} }
                                           ▼
                        Gemini (structured JSON output) → Zod-validated
                           { actions:[{type, itemId?, newItem?, assignees[], amountPaise?, confidence, ambiguities[]}] }
                                           ▼
                          Confirmation sheet (editable) → existing endpoints
```
- [ ] D4.1 **Spike (1 day):** test Web Speech API on Android Chrome, iOS Safari, **iOS installed PWA** (known to be unreliable in standalone mode) and Firefox. Decide per-platform: Web Speech vs **MediaRecorder → Gemini audio** fallback (same parse call can accept audio).
- [ ] D4.2 `POST /api/voice/parse` (auth, rate-limit 30/h/user, Zod in/out). Prompt provides member names + item list so names resolve to **IDs**, never free text. Ambiguity (two "Ravi") ⇒ return `ambiguities`, UI asks.
- [ ] D4.3 Money safety: amounts parsed to **integer paise**; reuse existing validators; **never auto-apply** — every action needs an explicit Confirm; show "what I understood" in plain words.
- [ ] D4.4 UI: mic button on Bill form / Bill detail / Settle dialog; live transcript; editable transcript; confirmation sheet; undo toast; permission-denied and unsupported states; a11y (button labels, not voice-only).
- [ ] D4.5 Languages: English + Hindi/Hinglish (set recognition `lang` by user setting; Gemini handles code-mixed text).
- [ ] D4.6 Privacy: transcripts/audio go to Google (Gemini) — disclose in-app; do not store audio; store only the parsed result if the user confirms.
- [ ] D4.7 **Eval set:** 40 labelled utterances (en + hinglish, incl. exclusions, quantities, number words like "do sau pachaas") with expected JSON; target ≥ 90 % action-exact on V1–V3, 100 % "no auto-save"; run as a repeatable script.
- [ ] D4.8 Cost/quota guard: reuse Gemini key; separate counters; graceful degrade to manual.
- [ ] Acceptance: owner completes V1–V4 on Android + iPhone PWA hands-free-ish in < 20 s each; wrong parse is always caught by the confirm step.

### D5 — Later / backlog
- [ ] D5.1 Soft-remove group member (see `BACKLOG.md`).
- [ ] D5.2 Email-based password reset (needs provider decision).
- [ ] D5.3 Push notifications (explicitly out of scope today).
- [ ] D5.4 Local on-device speech (Whisper on Pi) if cloud STT proves unreliable.

---

## 7. QA plan

### 7.1 Quality gates (every milestone)
`npm run check` ✅ · `npm run test` ✅ (57 money tests + new) · `npm run build` ✅ · `npm audit --omit=dev` no critical/high · manual checklist for the milestone · drills for infra milestones. State results honestly; failing = not done.

### 7.2 Test layers
| Layer | What | Tool |
|---|---|---|
| Unit | balance engine, `simplifyDebts`, idempotency, ID-range logic, sync merge rules, voice-parse validators | vitest |
| API integration | all routes against a **Postgres 17 container**; authz: user A ⇒ 403/404 on user B's group; role/`requireWritable`; idempotency | vitest + supertest |
| Sync | outbox ordering, retries, idempotent replay, tombstones, ID-range collisions, conflict LWW logging | vitest + 2 Postgres containers |
| E2E (UI) | login, group, bill, assign, settle, scan, voice (mocked STT) | Playwright (new dev dep, approved for QA) |
| Mobile matrix | see 7.4 | manual + BrowserStack-style real devices owned |
| Drills | failover/failback/power loss | scripted + manual |

### 7.3 Numbered QA scenarios
- **QA-1 Smoke (after any deploy/cutover):** register → login → create group → add bill (itemized) → assign → balances correct → logout/login persists session across restart.
- **QA-2 Parity:** same scripted scenario run against Pi stack and Render/Supabase stack ⇒ identical API results (golden-file diff).
- **QA-3 Sync correctness:** (a) insert/update/delete on Pi appears on Supabase ≤ 60 s; (b) kill sync-agent mid-batch ⇒ no loss/dup after restart; (c) 1k random ops fuzz ⇒ row-for-row equality; (d) deletes propagate.
- **QA-4 Data integrity:** script `scripts/verify-integrity.ts`: row counts per table, FK orphans, per-bill Σshares = total (paise exact), per-pair balance equality Pi vs standby, sequence > max(id).
- **QA-5 Power-cut drill (Pi):** during continuous writes, hard power off ×10 (including mid-sync); boot ⇒ self-check passes or correctly refuses writes; data loss ≤ replication window; restore-from-standby script works end to end (time it).
- **QA-6 Failover drill:** (1) stop Funnel → PWA redirects to Vercel within ≤ 15 s; (2) stop API container; (3) stop Postgres; (4) block internet at router; (5) Pi off. For each: controller flips to standby within ≤ 2 min; standby accepts writes; no duplicate on retry (idempotency).
- **QA-7 Failback drill:** write 20 mixed ops (incl. edit + delete + settlement) on standby; bring Pi up ⇒ reverse sync, verify (QA-4), cutover, no lost/duplicate rows, sequences correct, users prompted to switch back.
- **QA-8 Split-brain probe:** Pi up but only Render can't see it ⇒ no double-primary; fencing refuses stale writes; conflict log empty or explained.
- **QA-9 Keep-alive:** 14-day soak: Supabase stays active; Render responds < 3 s at random times; alert fires when a ping deliberately breaks.
- **QA-10 Security:** authz matrix per route; rate limits on login; Funnel exposure scan shows only 443; secrets absent from logs/git; cookie flags; session fixation on login; image URLs not guessable and not public.
- **QA-11 PWA:** installability, offline shell, update flow, no stale `/api` caching (change a balance ⇒ visible immediately).
- **QA-12 OCR:** 5-receipt protocol (D3.3) + review-screen DoD; unreadable photo ⇒ manual with image preserved.
- **QA-13 Voice:** eval set (D4.7) + device matrix + denied-permission + noisy environment + wrong-person ambiguity.
- **QA-14 Performance baselines (Pi):** p95 API latency for dashboard/bills at 25 users; DB size growth; memory < 60 % under load; cold boot → serving < 3 min.
- **QA-16 Logging:** (a) redaction test — fuzz requests containing passwords/tokens/cookies, assert none appear in any sink; (b) network-cut test per P8 acceptance (no loss/dup); (c) kill -9 the API ⇒ next boot logs `unclean_shutdown`; (d) flood 50k debug events ⇒ app latency unaffected, drops counted; (e) emergency brake triggers at the threshold, shipping of debug/info pauses/spools, standby stays writable; (f) confirm **no rows are deleted** during the first 14 days; (g) daily size report is produced.
- **QA-15 Regression:** Phase 1–4 checklists + all closed `BUG-n`.

### 7.4 Device & browser matrix
Android Chrome (installed PWA + tab) · Android Firefox · iOS Safari (tab + Home-Screen PWA) · iOS Chrome · Desktop Chrome/Safari/Firefox. For each: login persistence, cookie after redirect, install, camera, mic, dark mode, 360 px layout.

### 7.5 UAT loop
Bug Report sheet (owner-shared with testers) → triage to `BUG-n` with severity → fix + regression test → status in sheet. Weekly review during rollout. Rollout order: owner only → 2–3 friends → everyone.

### 7.6 Definition of Done — infra (owner verifies personally)
- [ ] Pi serves the app at the Funnel URL; PWA installs on Android + iPhone.
- [ ] All 25 users/11 groups/11 bills present on Pi; integrity script clean.
- [ ] Unplug Pi ⇒ within ~2 min users can keep working on the backup; plug back ⇒ changes appear on Pi, no duplicates, nothing lost beyond the documented window.
- [ ] Supabase, Render, Vercel all stayed responsive for 14 days with no manual restore.
- [ ] Restore-from-backup rehearsed and timed.

---

## 8. Risk register

| # | Risk | Likelihood | Impact | Mitigation | Residual |
|---|---|---|---|---|---|
| R1 | Power cut corrupts microSD / Postgres | Medium | High | durable PG settings, forward sync ≤ 60 s, nightly+weekly dumps, self-check + restore script, spare SD image, watchdog | Last ≤ 60 s of writes may be lost; recovery takes minutes |
| R2 | Supabase pauses again | High (observed) | High (standby dead) | S1: REST-API pings + real DB activity from sync, alerts, monthly check | Unproven until 14-day soak (QA-9) |
| R3 | Render free limits / sleeps | Medium | Medium | 10-min pings from 2 pingers; 750 h budget; cold start 43 s documented | Brief slow first request |
| R4 | Split-brain / duplicate writes | Low | High | fencing epoch, hysteresis, idempotency keys, conflict log | Rare manual review |
| R5 | ID collisions across sides | Low | High | standby sequences start at 1e9; tests | — |
| R6 | Funnel limits/outage (Tailscale) | Low | High (looks like Pi down) | failover handles it; monitor bandwidth | Installed-users-only failover (3.4) |
| R7 | Non-installed users hit error page when Pi down | Medium | Medium | share both links; onboarding says "install the app" | Accepted (D4) |
| R8 | iOS PWA limits (Web Speech, storage eviction, push) | High | Medium | D4.1 spike + audio fallback; no reliance on local storage for truth | Voice may use fallback on iOS |
| R9 | Gemini model retired / quota | Medium | Medium | configurable model; manual fallback always works | — |
| R10 | Secrets divergence between Pi and Render (`SESSION_SECRET`, DB URLs) | Medium | High | single source env matrix (App. B), checklist in M-cutover | — |
| R11 | Home internet/router outage | Medium | Medium | looks like Pi down ⇒ failover works | Writes continue on standby |
| R12 | Clock skew breaks LWW ordering | Low | Medium | NTP enforced, use DB `now()` | — |
| R13 | Free-tier policy changes (Supabase/Render/Vercel/Tailscale/GitHub) | Medium | Medium | quarterly review; offsite dumps | — |
| R15 | Log volume fills Supabase 500 MB ⇒ project read-only ⇒ **standby breaks** | Medium | High | `ops` schema isolated, no deletion for 14 d then measured, alerts at 150/350 MB, **emergency brake at 450 MB** (stop shipping debug/info), micro-batching; fallback: retention module or a second free Supabase project | Needs growth review at day 14 |
| R16 | Sensitive data leaks into logs | Medium | High | redaction helper + test, id-only user refs, no bodies | — |
| R14 | Schema drift between Pi and Supabase | Medium | High | migrations run on both in a defined order (Pi first, then standby) via one script; CI check compares schemas | — |

---

## 9. Milestones & sequencing

| M | Name | Contents | Exit criteria | Who |
|---|---|---|---|---|
| **M0** | Stabilise & prepare | D0.1–D0.4, **S1 (keep-alive v2 on `main`)**, copy phase docs (M0.5) | audit clean; Supabase pings verified active; docs in repo | CLAUDE + HUMAN (secrets) |
| **M1** | Pi base | P0, P1, P2, P3 (incl. storage driver, role flag, static serving) | stack boots on Pi from empty DB; QA-1 passes locally | HUMAN + CLAUDE |
| **M2** | Migrate data | P4 rehearsal → cutover runbook (no public switch yet) | QA-4 clean on Pi copy | HUMAN + CLAUDE |
| **M3** | Funnel + PWA | P5, D1 | installs on Android + iPhone from Pi URL | HUMAN + CLAUDE |
| **M4** | Sync & failover | S2 spike → S2–S7, S5 migration | QA-3, QA-6, QA-7, QA-8 pass | CLAUDE (+owner drills) |
| **M5** | Resilience & logging | P6, P7, **P8**, QA-5, QA-9 start, QA-16 | DoD infra checklist (§7.6) met | HUMAN + CLAUDE |
| **M6** | **Go-live on Pi** | announce, cutover, monitor 7 days | no data loss; alerts quiet | HUMAN |
| **M7** | Settlements + simplification | D2 | Phase 6 settlement DoD | CLAUDE |
| **M8** | OCR review | D3 | Phase 5 DoD | CLAUDE + HUMAN (key, receipts) |
| **M9** | Voice | D4 | D4 acceptance | CLAUDE |
| **M10** | Polish & wrap | onboarding/motion/a11y, full QA-15, tag `v1.0` | SPEC §22 reviewed together | both |

Dependencies: M1→M2→M3; S-work (M4) needs M2; M6 needs M3+M4+M5; M7–M9 can overlap with M4–M5 but **must be deployed behind the same sync/idempotency rules** (new tables/columns need outbox triggers — add to S5 checklist whenever a table is added).

**Immediate next actions (week 1):**
1. HUMAN: confirm P0 items; add `SUPABASE_URL` + `SUPABASE_ANON_KEY` as GitHub secrets (S1.1).
2. CLAUDE: M0 on a short-lived branch merged to `main` (workflows only run from `main`): keep-alive v2 + audit fixes + docs move.
3. CLAUDE: M1 step plan (per CLAUDE.md, wait for "go").

---

## 10. Open questions & assumptions (veto or answer; defaults apply otherwise)

| # | Question / assumption | Default if no answer |
|---|---|---|
| Q1 | Pi OS/hostname/SSH currently set up? Tailnet name? | Fresh Raspberry Pi OS Lite 64-bit |
| Q2 | OK to run Docker Compose on the Pi (vs bare-metal services)? | Docker Compose |
| Q3 | Alert channel besides GitHub email (ntfy.sh / Telegram / WhatsApp not possible free)? | GitHub email + ntfy.sh |
| Q4 | Offsite weekly backup destination (personal Google Drive via rclone?) | Google Drive |
| Q5 | Re-login on failover acceptable, or build S8 handoff? | Accept re-login first |
| Q6 | Replace Capacitor APK with PWA (D9)? | Yes |
| Q7 | Roadmap order settlements → OCR → voice (D10)? | Yes |
| Q8 | Voice languages: English + Hindi/Hinglish only? | Yes |
| Q9 | Should voice also cover V5 (balance questions)? | Optional, last |
| Q10 | Email provider for password reset (Resend / Gmail SMTP)? | Deferred; owner-run reset script |
| Q11 | Allow Playwright + vite-plugin-pwa as new deps? | Yes (named in this plan) |
| Q12 | Public sharing: give friends both URLs and ask them to install the PWA? | Yes |
| Q13 | Is a home-internet outage during failover acceptable (standby needs internet only on the user's phone)? | Yes — phones use their own data |

---

## Appendix A — Handy commands (reference; verify before running)

```bash
# Supabase → dump (public schema, data only)
pg_dump "$SUPABASE_DIRECT_URL" --schema=public --data-only --no-owner --no-privileges -Fc -f data.dump

# Pi: empty DB + schema via Drizzle, then data
npm run db:migrate --workspace=server
pg_restore --data-only --disable-triggers -d "$PI_DATABASE_URL" data.dump

# Fix sequences (per table)
SELECT setval(pg_get_serial_sequence('bills','id'), COALESCE(MAX(id),1)) FROM bills;

# Tailscale
tailscale up --authkey "$TS_AUTHKEY" --ssh --advertise-tags=tag:server
tailscale serve --bg 4000 && tailscale funnel --bg 443 on   # exact flags vary by version

# Health
curl -s https://<pi>.<tailnet>.ts.net/api/health/db
curl -s https://<pi>.<tailnet>.ts.net/api/health/role
```

## Appendix B — Environment variable matrix

| Var | Pi (primary) | Render (standby) | Notes |
|---|---|---|---|
| `NODE_ENV` | production | production | |
| `APP_ROLE` | `primary` | `standby` | P3.4 |
| `DATABASE_URL` | local Postgres | Supabase pooler | |
| `DATABASE_SSL` | `off` | `on` | P3.1 |
| `DATABASE_POOLER` | `false` | `true` | enables `prepare:false` |
| `SESSION_SECRET` | **same value** | **same value** | R10 |
| `CLIENT_ORIGIN` | (unused when same-origin) | Vercel URL | |
| `SERVE_CLIENT` | `true` | `false` | P3.3 |
| `STORAGE_DRIVER` | `local` | `supabase` | P3.2 |
| `RECEIPTS_DIR` | `/data/receipts` | — | |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | for sync-agent only | for storage + sync | server-only, never client |
| `SUPABASE_ANON_KEY` | — | — | **GitHub secret** for keep-alive only |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | yes | yes | D3.1 |
| `TS_AUTHKEY` | yes (tagged, reusable) | — | |
| `PI_PUBLIC_URL` | — | Funnel URL | controller probes |
| `VERCEL_URL` (client build) | — | — | S7 redirect target (public) |
| `CONTROLLER_ENABLED` | `false` | `true` | S3 |
| `LOG_SINK` | `supabase` | `supabase` | P8 |
| `LOG_LEVEL` | `info` | `info` | `debug` only temporarily |
| `LOG_SPOOL_DIR` / `LOG_SPOOL_MAX_MB` | `/data/logspool` / `50` | — | P8.6 |
| `LOG_DATABASE_URL` | Supabase pooler (server-only) | Supabase pooler | P8.4 |

## Appendix C — Glossary
**Primary/standby** — which stack currently accepts traffic. **Funnel** — Tailscale feature exposing one local port on a public HTTPS URL. **PWA** — installable web app (manifest + service worker). **Outbox** — durable change log table used to ship changes. **Fencing/epoch** — counter that lets a node prove it is still the legitimate primary. **RPO** — how much recent data could be lost (target ≤ 60 s). **LWW** — last-writer-wins conflict rule.

## Appendix D — Existing references
`CLAUDE.md` (rules) · `SPEC.md` (requirements) · `DEPLOYMENT.md` (current Vercel/Render/Supabase) · `IMPLEMENTATION-NOTES.md` · `BACKLOG.md` · `PHASE-5-ocr.md`, `PHASE-6-settle-ship.md` (to be moved to `docs/phases/`, task D0.3) · Bug sheet: *SplittingWisdom Bug Reports* (Google Sheets, shared with testers).

---

## Appendix E — Progress log (workstream D, kept short; commits are the source of truth)

| When | Commit | What |
|---|---|---|
| 2026-11-01 | `b720406` | `scripts/local-pg.sh` (throwaway Postgres 17 clusters under `.localdb/`), `scripts/qa-smoke.mjs` (QA-1, dependency-free, runs against any `BASE_URL`) |
| 2026-11-01 | `4931126` | **D0** audit fixes (prod deps now 0 vulns), IP+email login rate limit, `helmet`, `docs/phases/`, `server/scripts/reset-password.ts` |
| 2026-11-01 | `61a81c4` | **D1** PWA: manifest/icons/service worker, client failover (`client/src/lib/failover.ts`, 23 unit tests), install help, health CORS |
| 2026-11-01 | `52b902f` | **D2a** settlements: rules in `shared/lib/settlement.ts`, `POST/GET /api/settlements`, dialog, history, derived bill status |
| 2026-11-01 | (this one) | **D2b/D2c** simplify-debts view, onboarding, motion pass, a11y fixes (contrast tokens, names, pre-paint theme) |

**Still open in D2:** D2.1's `Idempotency-Key` handling and `requireWritable` are deliberately *not* wired yet — they land with workstream S (S6.1 / S3). The client already sends the key.

**How to run everything locally (no Docker needed):** `scripts/e2e-local.sh` starts a throwaway Postgres, a primary and a standby API + client, runs the 49-check API smoke test and all Playwright specs, then stops what it started. Needs Homebrew `postgresql@17` and Google Chrome. Never touches the production DB.

**Gotchas for anyone on this branch**
- After `npm install <pkg> --workspace=…`, run `node scripts/link-drizzle-orm.mjs` — npm prunes the `drizzle-orm` symlink that `drizzle-kit` needs (fresh installs recreate it via `postinstall`).
- Text accents use `text-*-ink` classes (`text-mint-ink`, `text-coral-ink`, …), **not** `text-mint`/`text-coral`: the brand tints fail WCAG contrast as text on light backgrounds. Use `bg-*`/`border-*` for fills and borders.
- If Express starts serving the client (P3.3) and a strict CSP is added: `client/public/theme-init.js` is a separate file on purpose (no inline scripts needed); fonts come from `fonts.googleapis.com`/`fonts.gstatic.com`.
- `client/vercel.json` rewrites `/api/*` to the Render API; Vercel previews are behind Vercel login (Deployment Protection) and their `/api` still points at production Render.

# PHASE 6 — Settlements, debt simplification, polish, Capacitor APK, ship

Read `CLAUDE.md` and SPEC.md sections 2.5, 3.7, 13, 19, 22 before planning. Phases 1–5 are live.

Renumbered from the original Phase 4 to make room for Phase 3 (registered-only
members/invite flow) and Phase 4 (Splitwise-inspired redesign). Also adds
debt simplification (§1a below), which CLAUDE.md originally listed as
out of scope — the human explicitly asked for it here as a deliberate scope
change, not a drift; treat it as approved, not optional.

**Goal:** full and partial settlements with history; debt simplification to
cut the number of paybacks; onboarding + motion polish; then wrap the app
with Capacitor, produce a signed APK, and publish it on GitHub Releases for
my friends to install. At the end, SPEC §22 acceptance criteria all pass.

**First produce a numbered implementation plan for my approval. Do not write code until I approve.**

## Scope

### 1. Settlements (SPEC §13)
- Enable the Settle buttons (dashboard, balances list, balance detail). Settlement dialog: person + direction stated in words ("You are paying Ravi"), outstanding amount shown, editable ₹ amount **pre-filled with the full outstanding and hard-capped at it** (no overpayment), optional note, optional date (default today), Cancel/Confirm.
- Validation: > 0, ≤ outstanding, double-submit prevented (disable on submit + idempotency key on the request).
- `POST /api/settlements` per SPEC §14: authorization (both parties share the group), Zod, paise. Balance engine already accepts settlements — wire real data through and extend tests: full settlement zeroes the pair, partial reduces exactly, settlement then new bill re-accumulates, over-settlement rejected server-side even if the client is bypassed.
- After confirm: single animated checkmark, auto-close, every affected surface (dashboard, balances, balance detail, group, activity) refreshed via query invalidation — no manual refresh anywhere.
- Balance detail gains a settlement history section (person, amount, date/time, note, checkmark) interleaved into the explanation: "Bills total ₹2,400 − settled ₹1,800 → outstanding ₹600". Activity page's Settled filter now means something: bills where all involved pairwise balances are covered show Settled; wire the Pending/Settled logic and counts.
- **Checkpoint A: commit** — settlement tests green; I'll run a real settlement between two accounts.

### 1a. Debt simplification (approved scope addition — see note above)
- Pure function in `shared/lib` (e.g. `simplifyDebts(pairwiseBalances)`), separate from `computeBalances`: given a group's current pairwise balances, computes the minimal set of payer→recipient→amount transactions that settle everyone up. Standard greedy min-cash-flow — repeatedly match the largest net creditor against the largest net debtor. Deterministic tie-break (lowest member id first) so results are reproducible and testable.
- This is a **presentation/suggestion layer only** — it never rewrites bills or balances, and the underlying ledger stays exactly as derived today (CLAUDE.md money rule 4 is unaffected). It only changes what settlement is *suggested*.
- Group page and Balances page get a "Simplify debts" view: today's direct pairwise list stays the default; the simplified view shows the reduced transaction set with a plain-language note ("6 debts simplified to 3 payments"). Tapping a suggested payment opens the same settlement dialog from §1, pre-filled.
- Vitest coverage: a cycle of 3+ people fully resolves in strictly fewer transactions than the pairwise list; total money moved is unchanged; a group already at the minimum shows no change; zero balances produce zero suggestions.
- **Checkpoint A2: commit** — I'll verify against a real multi-person group with several open debts that the suggested payments actually zero everyone out.

### 2. Onboarding + polish
- First-login onboarding (SPEC §6): three simple steps (Upload a bill → Assign items → Settle up) with lightweight inline SVG illustrations, "Upload your first bill" primary CTA, "Create a group" secondary, skippable, never shown again after dismissal.
- Motion pass per SPEC §19 only: FAB hover scale, card hover lift, page fade-in, mobile dialog slide-up / desktop fade-scale, settlement checkmark, skeleton shimmer. Respect `prefers-reduced-motion`.
- Sweep: every SPEC §17 state exists; every icon-only button has an aria-label; dialog focus traps verified; contrast checked in both themes.
- **Checkpoint B: commit + tag `v0.6` + deploy web.**

### 3. Capacitor → APK
- Add Capacitor to the client, pointed at the production Vercel URL (remote URL mode — the APK is a shell around the live web app, so web deploys update the app without reinstalls; state this trade-off in the README).
- Config: app id `com.sohil.splittingwisdom`, app name SplittingWisdom, icon + splash generated from a simple mint logo (create one — text-based is fine, no copied branding), status bar styled per theme, Android back button navigates history and exits from root, camera/file permissions declared for receipt capture.
- Verify inside the APK specifically: session cookie persistence across app restarts (if cookies are flaky in the WebView, switch to bearer-token auth stored in Capacitor Preferences — decide and implement), camera capture, safe-area insets, cold-start "waking server" interstitial.
- Signing: generate a keystore, document its passwords storage for me (losing it means friends must uninstall/reinstall for future updates), build a signed release APK.
- Write `RELEASE.md`: exact commands to build/sign, how to create a GitHub Release with the APK attached, and a short friendly install guide I can paste into WhatsApp (enable unknown sources, download, install, register, join via invite link).
- Add an in-app "what's new / update available" check against the GitHub Releases API (harmless if it fails offline).
- **Checkpoint C: commit + tag `v1.0` + GitHub Release with APK.**

### 4. Final acceptance
- Walk SPEC §22 criteria one by one and show me the status of each honestly. Anything failing gets fixed before we call it done.

## Out of scope
Play Store submission, push notifications, payment processing, iOS.

## Definition of done — I will personally verify
- [ ] Checks, tests, production build pass.
- [ ] Two-account settlement: partial ₹500 of ₹1,300 → outstanding ₹800 everywhere instantly; then full settle → pair shows Settled; history shows both entries with notes.
- [ ] A group with several open debts across 3+ people shows a simplified view with visibly fewer transactions than the raw pairwise list, and following those suggested payments actually settles everyone.
- [ ] Server rejects a settlement of ₹5,000 against an ₹800 balance (tested via direct API call).
- [ ] Double-tapping Confirm creates exactly one settlement.
- [ ] APK installs on my phone AND one friend's phone from the GitHub Release link.
- [ ] In the APK: login survives app kill + relaunch; camera receipt flow works; no layout breakage around notch/navigation bar.
- [ ] A brand-new user goes install → register → join group → assigned a bill → settles, entirely on the phone, no help from me.
- [ ] Full SPEC §22 checklist reviewed together, all green.

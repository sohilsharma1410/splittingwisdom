# PHASE 1 — Foundation: auth, groups, manual bills, equal splits, balances, deploy

Read `CLAUDE.md` and SPEC.md sections 4, 5, 6, 7, 8, 14, 15, 16, 17, 18 before planning.

**Goal:** a deployed, usable app where my friends and I can register, form a group, enter bills manually, split them equally, and see correct balances. No OCR, no item-level assignment, no settlements yet — a whole bill is split equally among selected members. This ships to real users at the end of the phase.

**First produce a numbered implementation plan for my approval. Do not write code until I approve it.**

## Scope

### 1. Project scaffold
- Vite + React + TS client, Express + TS server, `/shared` package, per CLAUDE.md stack.
- Tailwind configured with the SPEC §15 design tokens (light + dark). Theme toggle, persisted.
- App shell: desktop sidebar (logo, tagline "Split fairly. Understand everything.", nav: Dashboard / Groups / Activity / Balances, New Bill button, account area, theme toggle, collapsible) and mobile bottom tab bar + FAB for New Bill. Routes per SPEC §4 including not-found. Use wouter.
- **Checkpoint A: commit** — shell renders, routes navigate, themes work, mobile layout clean at 360px.

### 2. Database + auth
- Drizzle schema in `/shared/schema.ts`: users, groups, group_members, bills, bill_items, settlements (define settlements table now, use in Phase 4). Group members support EITHER a linked user_id OR a plain display name (name-based members), plus an invite token on the group so a registered user can join and claim a name-based member slot.
- Amounts columns are integer paise. Timestamps on everything.
- Migrations via drizzle-kit against the Supabase `DATABASE_URL`.
- Auth endpoints per SPEC §14 (`register`, `login`, `logout`, `me`), bcrypt, express-session with Postgres session store, httpOnly cookies, CORS locked to `CLIENT_ORIGIN` with credentials.
- Client: register/login pages, protected route wrapper, account menu with initials avatar + logout. Friendly invalid-credential errors. New accounts land on an empty-state dashboard.
- **Checkpoint B: commit** — I will manually test: register two users in two browsers, confirm sessions persist on refresh, confirm user A cannot fetch user B's data.

### 3. Groups
- Create-group flow per SPEC §8: name, add members by typing names (Enter-to-add, chips, duplicate prevention, remove), validation, success toast, navigate to new group.
- Groups list: responsive card grid — name, avatar stack, member count, bill count, my balance in the group (positive/negative/settled with icon + text, never color alone), last activity.
- Group detail: metadata, member grid with per-member group balance, bill list, add-member, invite link (copyable; a logged-in user opening it picks which name-based member they are, or joins as new), group settings menu with rename and delete (confirmation dialog).
- **Checkpoint C: commit.**

### 4. Manual bills + equal split
- "New Bill" opens a form (modal on desktop, full-screen on mobile): description, merchant (optional), date (calendar popover), group selector, payer selector (any group member), total amount (₹, right-aligned, tabular numerals), optional tax/tip/service fee/discount fields behind a "Add tax & charges" disclosure, and a member multi-select "Split equally between" defaulting to all members.
- On save: create the bill with ONE implicit arrangement — equal split among the selected members using the paise remainder rule. (Bill items and per-item assignment arrive in Phase 2; model this as a bill with a single item "Entire bill" so Phase 2 is a natural extension, but do not build item UI yet.)
- Live preview inside the form: each selected member's computed share, updating as inputs change. Warn if total ≤ 0.
- Bill detail page: all bill info, per-person share breakdown with a plain-language "How was this calculated?" section (subtotal → charges allocation → rounding note), edit and delete (confirm) actions, edit history line ("edited by X at time").
- **Checkpoint D: commit** — with balance tests passing (see below).

### 5. Balance engine + Balances/Dashboard/Activity pages
- Implement `/shared/lib/balance.ts` pure function + vitest suite per CLAUDE.md money rules (settlements array will be empty until Phase 4, but the function signature includes it now).
- `GET /api/balances` and `GET /api/balances/:memberId` computing pairwise person-to-person balances for the current user across shared groups.
- Balances page per SPEC §12: net summary cards, All / Owed to You / You Owe filters, balance cards (icon + text direction, amount, last activity), navigation to balance detail.
- Balance detail: person, outstanding amount, list of contributing bills with each bill's effect on this balance ("Goa dinner: they paid ₹2,400, your share ₹600 → you owe ₹600"). Settle button present but disabled with tooltip "Settlements arrive in a later update".
- Dashboard per SPEC §7: header, net balance card, active groups card, recent bills card, recent activity list, outstanding balances list. All live data.
- Activity page: date-grouped bill cards with All/Pending/Settled filter shells (everything is Pending in Phase 1), counts on filters, expandable per-person breakdown.
- All pages: loading skeletons, empty states with heading + explanation + icon + CTA (SPEC §6), error + retry states.
- **Checkpoint E: commit.**

### 6. Deploy
- Server on Render (free): build command, health endpoint, env vars documented. Add a client-side "Waking the server…" interstitial when the first API call is slow (cold start).
- Client on Vercel: env for API base URL, SPA rewrites.
- Write `DEPLOYMENT.md` with exact click-by-click steps for me: Supabase project + DATABASE_URL, Render service setup, Vercel setup, running migrations.
- **Checkpoint F: commit + tag `v0.1`.**

## Out of scope for this phase (refuse politely if I drift)
Receipt upload/OCR, per-item assignment, percentage/ratio/custom splits, settlements (beyond schema + disabled button), onboarding illustrations beyond simple empty states, Capacitor.

## Definition of done — I will personally verify
- [ ] `npm run check`, all tests, and production builds pass; you've shown me the output.
- [ ] Two users in two browsers: register, one creates group "Test Trip" with the other + a name-based member "Ravi".
- [ ] Second user joins via invite link and claims a slot.
- [ ] Bill: ₹1,000 + ₹180 tax split equally among 3 → shares sum to exactly ₹1,180; remainder paise visibly explained in "How was this calculated?".
- [ ] Bill with total ₹100 split among 3 → shares are ₹33.34/₹33.33/₹33.33 (deterministic), sum exact.
- [ ] Editing the bill total updates every balance everywhere (dashboard, balances, group) without refresh.
- [ ] Deleting the bill removes its effect from all balances after confirmation.
- [ ] User A cannot access user B's group by URL (403/404 page, not a crash).
- [ ] Whole flow works on my phone browser at the deployed URL, no horizontal scroll, bottom nav doesn't cover content.
- [ ] Dark mode: every screen readable, currency legible, persists across reload.

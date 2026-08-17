# SplittingWisdom — Project Memory

Read this before every task. These rules override convenience.

## What this project is

A bill-splitting web app (later wrapped to Android APK via Capacitor) for a real friend circle. Item-level splits, receipt OCR, traceable balances, settlements. Full requirements: `SPEC.md`. Work is phased; the current phase's file (PHASE-N-*.md) defines scope. Never build ahead of the current phase.

## Stack (fixed — do not substitute)

- Frontend: React 18 + TypeScript + Vite + Tailwind + Radix UI + Lucide + TanStack Query + wouter (routing)
- Backend: Express + TypeScript, deployed on Render free tier
- DB: PostgreSQL on Supabase free tier, accessed via Drizzle ORM from the Express server
- Auth: session-based (express-session + connect-pg-simple, cookie sessions), passwords hashed with bcrypt. Do NOT use Supabase Auth — we use Supabase only as a Postgres host + storage bucket.
- File storage: Supabase Storage bucket for receipt images (server-side upload via service key; never expose service key to client)
- OCR (Phase 3 only): Google Gemini API free tier, called from the Express server
- Monorepo layout: `/client`, `/server`, `/shared` (Drizzle schema + Zod schemas live in `/shared`, imported by both sides)

## Money rules (non-negotiable)

1. All amounts stored and computed as **integer paise** (INR minor units). Never float. Never compute money in JS `number` arithmetic on rupee values — convert to paise integers at the edge, compute, convert back for display only.
2. Currency: INR only. Display format: `₹1,234.56` using `Intl.NumberFormat('en-IN')`. Inputs accept rupees with 2 decimals, converted to paise on parse.
3. Rounding: when splitting P paise among N people, each gets `floor(P/N)`; distribute the remainder paise one each to members in deterministic order (sorted by member id). Document this rule in the "how was this calculated" UI.
4. Every balance is **derived, never stored**. Balances = sum over item assignments + proportional tax/tip/fee/discount shares − settlements. One pure function in `/shared/lib/balance.ts` computes it; server endpoints call it; it is the single source of truth.
5. Tax, tip, service fee are allocated proportionally to each person's pre-tax item subtotal on that bill. Discounts likewise (negative). Rounding rule from #3 applies. A person with zero items on a bill owes zero tax/tip on it.
6. The balance function must have unit tests (vitest) covering: equal splits with remainders (e.g. 100 paise / 3), percentage splits, custom amounts, tax+tip allocation, discounts, settlements, partial settlements, multi-bill accumulation, and the invariant **sum of all shares on a bill = bill total exactly**. Run these tests before every commit that touches money logic.

## Engineering rules

- TypeScript strict mode. `npm run check` (tsc) must pass before every commit.
- Zod validation on every API input. Shared Zod schemas in `/shared` are the contract for both client forms and server validation.
- Every API route: auth check → zod parse → authorization check (is this user in this group?) → action → consistent JSON `{ data }` or `{ error: { message } }` with correct HTTP status.
- Authorization: a user may only read/write groups they are a member of, and bills/settlements/balances within those groups. Test this: user A must get 403/404 on user B's group.
- TanStack Query: mutations must invalidate every affected query key (balances, group, dashboard, activity). A stale balance on screen after a settlement is a bug, full stop.
- No console.log as user feedback. Every action gets visible UI feedback (toast/inline state).
- Destructive actions (delete group, delete bill, remove member) require a confirmation dialog.
- Loading, empty, and error states for every async view. Skeletons for lists, spinners for actions, retry buttons on errors.
- Accessibility: labeled inputs, aria-labels on icon buttons, focus trap in dialogs, Escape closes dialogs, no color-only meaning (owed/owing always has an icon + text).
- Mobile-first: every screen must work at 360px width with no horizontal scroll. Bottom tab nav on mobile, sidebar on desktop.

## Design tokens

Follow SPEC.md §15: mint #5BC5A7 primary, coral #FF6B6B for debt/settle actions, bg #F8F9FA, text #2C3E50, teal accent #4ECDC4. Dark mode: dark slate bg, elevated cards, softened mint/coral, same semantics. Fonts: Inter (UI), Roboto (body), tabular numerals for all currency. rounded-xl cards, rounded-lg buttons/inputs. Theme persisted in localStorage, respects prefers-color-scheme on first load.

## Workflow rules

- At the start of each phase: read the phase file, produce a step plan, WAIT for approval before writing code.
- Commit at each checkpoint marked in the phase file, with a clear message (`phase1: auth complete`, etc.).
- Before claiming a phase complete: run `npm run check`, run all tests, run the production build (`npm run build`), and state the results honestly. If anything fails, it's not complete.
- Do not add features, packages, or abstractions not required by the current phase. When tempted, append the idea to `BACKLOG.md` instead.
- Environment variables documented in `.env.example`; never commit real secrets. Required vars so far: `DATABASE_URL`, `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY` (Phase 3+), `CLIENT_ORIGIN`.

## Explicitly out of scope (never build unless the human asks)

Real payment processing, bank integrations, multi-currency, debt simplification/netting across people, notifications/emails, chat, public profiles, admin dashboards, subscription billing, role-based access control.

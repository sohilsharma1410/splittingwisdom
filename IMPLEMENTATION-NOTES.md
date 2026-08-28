# Implementation Notes — Phase 1

Read alongside `CLAUDE.md`, `SPEC.md`, and `PHASE-1-foundation.md`. This
documents where the actual Phase 1 build deviates from (or adds to) the
original spec, so a fresh session — or a fresh set of eyes — doesn't
mistake an intentional decision for a bug, or a bug for a spec change.

## Deployed URLs
- Client: https://splittingwisdom-client.vercel.app
- API: https://splittingwisdom-api.onrender.com

## Deviations / enhancements from the original spec

1. **`item_assignments` table exists from Phase 1**, even though the
   Phase-1 schema bullet list only named users/groups/group_members/
   bills/bill_items/settlements. Required by `CLAUDE.md` money rule #4
   ("balances = sum over item assignments"), and matches the phase
   file's own instruction to model bills as one "Entire bill" item so
   Phase 2 is additive, not a rewrite. Phase 1 always writes
   `split_type='equal'` rows; the `percentage`/`ratio`/`custom_amount`
   columns exist but are unused until Phase 2.

2. **A bill's "total amount" field is the pre-tax subtotal.** Tax,
   tip, service fee, and discount are added/subtracted on top; the
   grand total is always derived at read time, never stored —
   consistent with "every balance is derived, never stored."

3. **Balance counterparty identity**: a linked (registered) member's
   balance merges across every group you share with them, keyed by
   their user id. A name-based (unregistered) member's balance is
   scoped to the one group they exist in, keyed by their group-member
   id — they have no identity outside that group until someone claims
   the slot via the invite link. This wasn't spelled out explicitly in
   SPEC and was a judgment call.

4. **UI primitives are hand-built** wrappers over Radix + Tailwind
   (Button, Dialog, Select, Checkbox, etc. in `client/src/components/ui`),
   not a third-party component library — matches the "Radix UI +
   Tailwind" stack line literally, no deviation, just noting it's not
   e.g. shadcn/ui as a dependency.

5. **Post-signoff UX changes**, added in response to real usage feedback
   after the initial build:
   - A back-navigation button (goes to actual browser history, not a
     fixed parent route) on Bill/Group/Balance detail pages.
   - The bill form's "Split equally between" member list collapses to
     a one-line summary ("Everyone (N people) · Change") by default,
     instead of always showing every member as a checkbox.
   - Bill detail's "How was this calculated?" is a short sentence plus
     a compact per-person line (e.g. "₹333.34 item + ₹60.00 tax"), not
     the original numbered-paragraphs-plus-dense-table version.

6. **Deployment-specific fixes** — not spec deviations, but real
   findings baked into `DEPLOYMENT.md` and the code, worth knowing if
   anything looks non-obvious in server setup:
   - Render/Vercel builds need `npm install --include=dev` — both
     platforms set `NODE_ENV=production` during the build itself,
     which silently drops devDependencies (typescript, drizzle-kit,
     tsx) on a plain `npm install`, breaking the build in a confusing
     way (fell back to a different globally-installed TypeScript).
   - `app.set("trust proxy", 1)` is required in `server/src/index.ts`
     — without it, secure session cookies never reach the browser
     behind Render's reverse proxy (confirmed by reading
     express-session's source directly).
   - `connect-pg-simple`'s session store needs an explicit
     `ssl: { rejectUnauthorized: false }` — its underlying `pg` pool
     doesn't auto-negotiate SSL the way the app's main `postgres.js`
     connection (via Drizzle) does, and Supabase requires it. Without
     this, session writes failed silently and unpredictably.

## Explicitly confirmed out of scope for Phase 1 (not bugs)
- Item-level entry / percentage / ratio / custom splits — Phase 2.
- Settlements (the Settle button is deliberately disabled with a
  tooltip) — Phase 4.
- Password recovery — not built, and not currently planned in any
  phase file. `CLAUDE.md` excludes "notifications/emails" entirely,
  which is the normal way to build this. If wanted later, it needs a
  decision on how to do it without email, and should go in
  `BACKLOG.md` until then.

## Test data note
Various throwaway test accounts were created and deleted during
development/debugging — the database should be clean of them. One
real account (`sohilsharma@hotmail.com`) exists from manual testing;
if the password is forgotten, it can be reset the same way it was
before — directly in the database, not via a real recovery flow
(none exists).

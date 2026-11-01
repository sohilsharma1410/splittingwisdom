# Backlog

Ideas and requests that came up mid-phase but are out of scope for the current
phase. Nothing here gets built until a human explicitly moves it into a phase
file.

## Speak the split while a receipt is read (idea, not approved)

After taking the photo, the person says who had what ("Priya and I shared the biryani, Karan had the
naan"). The speech text, the OCR items and the group's members are matched into a pre-filled split on
the review screen, using a small language model on the Pi. It extends D4 (voice) and would change D8,
which uses Gemini for parsing. Ground rules if it goes ahead: the model only links item numbers to member
IDs and shares, never amounts; `shared/lib` computes all the money; anything unclear stays unassigned;
nothing saves without Confirm. Unknowns: Chrome sends speech to Google by default, iPhone installed-app
support is unconfirmed, and no model has been measured on this task. Start with the D4.7 eval set and a
rule-based matcher, and add a model only if the rules fall short.

## Undo / delete a settlement

Phase 6 records payments but has no way to reverse a mistaken one (wrong amount, wrong person, recorded twice before idempotency existed). Needs a design before building: who may undo (either party? only the recorder?), whether it's a hard delete or a visible reversal entry (the latter keeps the ledger auditable and fits "traceable balances"), and how it interacts with derived bill status. Until then a wrong payment can only be offset by recording a payment the other way.

## Drop the unused `bills.status` column

Bill Settled/Pending is now derived from bills + settlements (`shared/lib/settlement.ts`, `server/src/lib/bill-status.ts`). The stored `bills.status` column is never read or updated any more. Remove it in a migration once the Pi/standby sync schema (plan S5) settles, so it isn't two migrations touching the same tables.

## Settlements between people who aren't directly in debt (simplify-debts payments)

The server accepts a payment A→C when A owes B and B owes C, up to the payer's overall debt and the recipient's overall credit (needed so "simplify debts" suggestions can be followed). The pairwise ledger then shows C owing A, which nets to zero in everyone's overall position but can look odd in the per-person view. Revisit the presentation once real groups use it.

## Content-Security-Policy for the Pi-served client

Express now serves the web app on the Pi with helmet's CSP still off. A real policy is worthwhile, but needs testing against the service worker and Google Fonts. `client/public/theme-init.js` is already a separate file, so no inline scripts are needed.

## Compress responses from the Pi

Express serves the client uncompressed, and Funnel's bandwidth is limited. If the first load feels slow, pre-compress the build or add a compression step.

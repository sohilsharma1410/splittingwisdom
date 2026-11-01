# Backlog

Ideas and requests that came up mid-phase but are out of scope for the current
phase. Nothing here gets built until a human explicitly moves it into a phase
file.

## Undo / delete a settlement

Phase 6 records payments but has no way to reverse a mistaken one (wrong amount, wrong person, recorded twice before idempotency existed). Needs a design before building: who may undo (either party? only the recorder?), whether it's a hard delete or a visible reversal entry (the latter keeps the ledger auditable and fits "traceable balances"), and how it interacts with derived bill status. Until then a wrong payment can only be offset by recording a payment the other way.

## Drop the unused `bills.status` column

Bill Settled/Pending is now derived from bills + settlements (`shared/lib/settlement.ts`, `server/src/lib/bill-status.ts`). The stored `bills.status` column is never read or updated any more. Remove it in a migration once the Pi/standby sync schema (plan S5) settles, so it isn't two migrations touching the same tables.

## Debt loops that cancel out (follow-up to simplify debts)

Paying a simplified suggestion is now recorded as the chain of real debts it stands for, so chains leave nothing behind. A loop of debts that nets to zero (Ann owes Bob, Bob owes Cat, Cat owes Ann) still shows in the Direct tab, with the Simplified tab saying "everyone is settled overall". Consider an explicit "clear offsetting debts" action that records the loop as settlements, once real groups show it matters.

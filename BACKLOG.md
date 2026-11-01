# Backlog

Ideas and requests that came up mid-phase but are out of scope for the current
phase. Nothing here gets built until a human explicitly moves it into a phase
file.

## Speak the split while a receipt is read (moved to the plan)

Approved to build on 2026-11-01: see D21 and D4.9-D4.12 in `PLAN-PI-PRODUCTIONIZATION.md`. The notes below are the background.

After taking the photo, the person says who had what ("Priya and I shared the biryani, Karan had the
naan"). The speech text, the OCR items and the group's members are matched into a pre-filled split on
the review screen, using a small language model on the Pi. It extends D4 (voice) and would change D8,
which uses Gemini for parsing. Ground rules if it goes ahead: the model only links item numbers to member
IDs and shares, never amounts; `shared/lib` computes all the money; anything unclear stays unassigned;
nothing saves without Confirm. Unknowns: Chrome sends speech to Google by default, iPhone installed-app
support is unconfirmed, and no model has been measured on this task. The rule-based matcher and test sentences
exist, unconnected to the app, and results are in `docs/PI-STATUS.md`. Next: collect real speech, then try a model.

Owner direction since then: **English only**, and consider running speech recognition on the Pi too, so nothing depends on
Google or Apple. That would mean recording on the phone, sending the audio to an isolated container on the Pi, deleting it
straight after, and testing `tiny.en` and `base.en` Whisper models on real recordings before building anything. The Hindi and
Hinglish rules and test sentences in `speech-split` are no longer needed, and should go when this is picked up.

## Undo / delete a settlement

Phase 6 records payments but has no way to reverse a mistaken one (wrong amount, wrong person, recorded twice before idempotency existed). Needs a design before building: who may undo (either party? only the recorder?), whether it's a hard delete or a visible reversal entry (the latter keeps the ledger auditable and fits "traceable balances"), and how it interacts with derived bill status. Until then a wrong payment can only be offset by recording a payment the other way.

## Drop the unused `bills.status` column

Bill Settled/Pending is now derived from bills + settlements (`shared/lib/settlement.ts`, `server/src/lib/bill-status.ts`). The stored `bills.status` column is never read or updated any more. Remove it in a migration once the Pi/standby sync schema (plan S5) settles, so it isn't two migrations touching the same tables.

## Debt loops that cancel out (follow-up to simplify debts)

Paying a simplified suggestion is now recorded as the chain of real debts it stands for, so chains leave nothing behind. A loop of debts that nets to zero (Ann owes Bob, Bob owes Cat, Cat owes Ann) still shows in the Direct tab, with the Simplified tab saying "everyone is settled overall". Consider an explicit "clear offsetting debts" action that records the loop as settlements, once real groups show it matters.

# SplittingWisdom Build Playbook — How to Use These Files

You have 8 files. Here is exactly what to do with each.

**Roadmap update (post-Phase-2 live feedback):** two phases were inserted
after real usage — Phase 3 (registered-only members/invite flow, bill-creation
rework) and Phase 4 (Splitwise-inspired redesign) — pushing the original
Phase 3 (OCR) to Phase 5 and Phase 4 (settle/ship) to Phase 6. See the note at
the top of each renumbered file for why.

## The files

| File | What it is | Where it goes |
|---|---|---|
| `README-START-HERE.md` | This file. Process instructions for YOU, not Claude Code. | Keep for reference |
| `CLAUDE.md` | Project memory file Claude Code reads automatically every session | Root of your project repo |
| `SPEC.md` | (You create this) Your full 22-section requirements doc, saved as-is | Root of your project repo |
| `PHASE-1-foundation.md` | Prompt for Phase 1 | Paste into Claude Code when starting Phase 1 |
| `PHASE-2-item-splits.md` | Prompt for Phase 2 | Paste after Phase 1 is deployed and used |
| `PHASE-3-ux-foundations.md` | Prompt for Phase 3 (inserted) | Paste after Phase 2 is stable |
| `PHASE-4-redesign.md` | Prompt for Phase 4 (inserted) | Paste after Phase 3 is stable |
| `PHASE-5-ocr.md` | Prompt for Phase 5 (was Phase 3) | Paste after Phase 4 is stable |
| `PHASE-6-settle-ship.md` | Prompt for Phase 6 (was Phase 4) | Paste after Phase 5 is stable |

## One-time setup (do this before any prompt)

1. Create accounts (all free): GitHub, Supabase, Vercel, Render, Google AI Studio (for the Gemini API key used in Phase 5).
2. Create an empty GitHub repo named `splittingwisdom`.
3. Clone it locally. Copy `CLAUDE.md` into the repo root.
4. Save your full requirements document as `SPEC.md` in the repo root.
5. Open the repo folder in Claude Code.

## The working rhythm (this matters more than the prompts)

For EVERY phase:

1. **Plan first.** Start the phase by asking Claude Code to read the phase file and produce a plan — do not let it write code yet. Read the plan yourself. You are a PM; review it like a PRD breakdown. Cut anything that isn't in the phase scope.
2. **Approve, then build.** Tell it to proceed. Let it work in its listed order. Don't inject new feature ideas mid-phase — write them down in a `BACKLOG.md` instead.
3. **Verify with the checklist.** Every phase file ends with a manual test checklist. Do every item yourself in a real browser/phone. Do not skip this because "the code looks right."
4. **Commit at every checkpoint.** The prompts tell Claude Code to commit at defined points. If something breaks, you can always roll back.
5. **Deploy at the end of every phase, not just the last one.** Real friends using Phase 1 will teach you more than any amount of Phase 2 polish.

## Things I observed in your spec that need YOUR decisions (not Claude Code's)

These are flagged inside the phase prompts too, but decide them consciously:

1. **Currency.** Your spec says `$` prefix on inputs. You're in India with an Indian friend circle. I've changed it to ₹ (INR) throughout the prompts. Confirm or change back — but pick ONE currency; multi-currency is explicitly out of scope.
2. **Members without accounts.** Your spec originally allowed "name-based members" (no login) as a permanent, first-class concept — the single biggest friction-killer for friend groups, and Phase 1 built it that way: creator adds names; any registered user can claim a member slot via invite link. **Live usage after Phase 2 changed this decision**: an unlinked member now causes real confusion and is being narrowed to a transient "invited, not yet joined" state rather than a permanent one — see Phase 3. If you want something different again, edit Phase 3 before running it.
3. **Who can edit a bill?** Spec says "avoid silently changing assignments." The prompts implement: any group member can edit, every edit is timestamped with who did it, shown in bill history. Alternative (only payer can edit) is stricter — your call.
4. **Overpayment on settlement.** Spec says prevent unless "intentionally supported." Prompts implement: hard block, amount capped at outstanding balance. Simpler and safer for friends.
5. **Simplify debts?** (A owes B, B owes C → A owes C.) Originally NOT in scope — my original take was that it undermines the "traceable balances" differentiator, and I said to resist the temptation when a friend requests it. **That's been overridden after live feedback**: it's now explicitly in Phase 6, as a presentation-layer suggestion only — it never touches the underlying traceable ledger, so the original concern is addressed by keeping it additive rather than by leaving it out.

## Budget reality check

- Supabase free: pauses after ~1 week of NO activity. Daily usage keeps it alive. If it ever pauses, one dashboard click resumes it.
- Render free: your API cold-starts after ~15 min idle. First request of the day takes ~30-60s. The prompts add a loading message for this. Live with it — it's the price of free.
- Gemini free tier: comfortably covers friend-circle receipt volume. If you hit limits, manual entry still works — OCR failing never blocks a bill.
- Your Claude Code subscription: a phase is several working sessions. If you hit a session limit mid-phase, the committed checkpoints mean you lose nothing — resume next session with "continue from the last checkpoint in PHASE-N".

## What "done" means

You are done when the Phase 6 checklist passes AND three friends have each: installed the APK, been in a group, had at least one bill assigned to them, and settled at least one balance. That's your real acceptance test.

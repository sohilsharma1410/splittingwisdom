# PHASE 4 — Splitwise-inspired visual & information-architecture redesign

Read `CLAUDE.md` and SPEC.md sections 4, 6, 7, 10, 11, 12, 15, 16 before planning. Phases 1–3 are live with real users giving real feedback — this phase exists because that feedback said the current UI, while functionally correct, is hard to scan, inconsistent about what's collapsible, and visually noisy on the pages that matter most (bill detail, activity).

**This is an explicit, approved scope addition**, not drift — the human asked for a Splitwise-inspired redesign as a real priority, with the instruction: match Splitwise's UX where it's what users already expect, deviate only where SplittingWisdom has an obvious improvement (the whole point of item-level transparency, SPEC §3.1). Don't copy Splitwise's exact visuals/branding (CLAUDE.md/SPEC §3.10, §20 already require this) — copy the *muscle memory* (where actions live, what's a list vs. a detail view, how much is on screen at once).

**First produce a numbered implementation plan for my approval — screen by screen, not just "redesign the UI." I want to see, before any code changes, what changes on Dashboard, Groups, Group Detail, Bill Detail, Balances, Balance Detail, and Activity, and why. Do not write code until I approve.**

## Why now, not later
This is sequenced right after Phase 3 (not before) because Phase 3 changes the member-add flow and the bill-creation/assignment flow — redesigning those screens now and again once Phase 3 lands would be double work. It's sequenced *before* OCR (now Phase 5) so OCR's review screen gets built once, against the final layout.

## Scope

### 1. Information architecture pass
- Navigation and dashboard: what's shown, in what order, and why — per SPEC §7 intent ("what requires attention now") but reconsidered against what actually turned out cluttered in practice. Produce a specific before/after for the plan, not just "cleaner."
- Every expandable section in the app gets an explicit, consistent collapse affordance — the current bugs where something can open but not close (or the state is unclear) are fixed as part of this pass, not patched individually beforehand.
- Consistent terminology sweep: "Quick Split" vs "Itemize" (already relabeled in Phase 3/pre-work), any other confusing toggle/label the human flags during review.

### 2. Bill detail rework (the specific "multicoloured nightmare" complaint)
- Replace the dense multi-colored per-item contribution bars (built in Phase 2, since walked back by user feedback) with a calmer default view: a plain, always-visible one-line split summary per person (no bars, no dense color), with detail available on demand.
- "How was this calculated?" stops being an inline expand that gets long and unstable-feeling. Basic per-person split is visible without any tap. A "See full breakdown" action opens a modal/sheet for the itemized, per-charge detail — so transparency (SPEC §2.1, §3.3's whole reason to exist) isn't lost, just no longer forced onto the main view.
- Same treatment applies to Activity's expandable item bars and Balance Detail's contributing-bill expansion — one consistent pattern (compact by default, modal for depth) everywhere "how was this calculated" shows up, rather than three different inline patterns.

### 3. Visual pass
- Reconsider the member color-coding introduced in Phase 2 — keep it if it survives the calmer bill-detail redesign, drop or scale it back if it doesn't.
- Card density, spacing, and hierarchy pass on Dashboard/Groups/Balances list views against Splitwise's actual scanability, without copying its exact visuals.

## Out of scope
Any backend/data-model change (this phase is presentation-layer only, built on top of whatever Phase 3 shipped), OCR, settlements, debt simplification, new features not already covered by an existing phase.

## Shipped — ✅
Scope turned out narrower than the doc above assumed, once every screen was actually read (see the approved plan for the full reasoning):
- **Collapse-affordance audit**: no bug found — every expandable section already used a consistent, working chevron-toggle. Nothing to fix here.
- **Bill Detail**: `ItemRow`'s per-person assignment chips no longer use `memberColor` (a different hue per person) — one neutral style now, regardless of who's assigned. The always-visible "Per-person share" list (already calm, already tap-free) is unchanged. "How was this calculated?" is now a "See full breakdown" action opening a `Dialog` instead of an inline expand — same content, no longer inline.
- **Activity**: the per-item colored progress bars + colored-dot legend are gone, replaced by a plain "name · price · who (share)" list inside the same "See full breakdown" `Dialog` pattern as Bill Detail.
- **Balance Detail**: its expand-in-place item list (already plain, no color) now opens in the same `Dialog` pattern for consistency — a mechanical change, since the content itself needed no decluttering.
- **Member color-coding**: kept only in `AssignmentEditor` (an active multi-select, where color helps you track who you've picked) — removed from every passive display (`bill-detail.tsx`, `activity.tsx`). `member-colors.ts` stays as a file with that one remaining caller.
- **Dashboard / Groups / Group Detail / Balances (list)**: no structural change — none had a density or inline-expand problem to begin with.
- New shared building block: `client/src/components/bills/breakdown-dialog.tsx` (the one modal shell reused by all three screens above).
- Verified live: a 3-item, 3-person bill with a percentage-split item, in both mobile (375px) and desktop widths — Bill Detail, Activity, and Balance Detail's breakdown modals all show correct, calm, non-color-coded data; `AssignmentEditor` still shows its per-member colored chips.

## Definition of done — I will personally verify
- [x] Checks, tests, build pass.
- [x] Every expandable section in the app has an obvious way to collapse it again. (Audited — already true; the three "how was this calculated" spots are now modals, not expand/collapse at all.)
- [x] Bill detail is not visually "a lot" at first glance, and I can still get the same transparency I could before (item-level, split-method, charge-proportion) within one extra tap.
- [ ] I show a friend a bill cold and they understand their share without me explaining it — same bar as Phase 2, now also easy on the eyes. *(Needs a real person, not something I can verify myself.)*
- [x] Mobile (360px) pass: no regressions on anything Phase 1/2's mobile checklist already covered.

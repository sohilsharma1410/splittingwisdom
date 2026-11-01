# PHASE 2 — Item-level splits and explainable balances (the differentiator)

Read `CLAUDE.md` and SPEC.md sections 2.1, 2.4, 3.1, 3.3, 3.4, 10, 12 before planning. Phase 1 is deployed and in use — do not break existing data; write a migration path for existing single-item bills.

**Goal:** bills become lists of line items; each item is assigned to one or more members with equal / percentage / ratio / custom-amount splits; every balance is traceable person → bill → item. This phase is the product's reason to exist — the "How was this calculated?" experience must be excellent, not an afterthought.

**First produce a numbered implementation plan for my approval, including the data migration for existing Phase 1 bills. Do not write code until I approve.**

## Scope

### 1. Schema + engine extension
- Add `item_assignments` table per SPEC §14 (bill_item_id, member_id, split_type equal|percentage|ratio|custom, value fields; paise for custom amounts).
- Migrate Phase 1 bills: their "Entire bill" item gets equal assignments matching the original member selection. Verify: every pre-existing balance is IDENTICAL after migration (write a script that snapshots balances before and compares after).
- Extend `/shared/lib/balance.ts`: per-item share computation for all four split types, then per-bill tax/tip/fee/discount allocation proportional to each member's item subtotal, remainder rule throughout.
- Extend the vitest suite: percentage rounding (33.33/33.33/33.34 must sum to item price), ratio splits (2:1:1), custom amounts summing exactly, one item multi-person + another single-person on the same bill, member with zero items pays zero charges, invariant sum-of-shares = bill-total on every generated case. Add a property-based style test: 200 random bills, invariant must always hold.
- **Checkpoint A: commit** — tests green, migration verified.

### 2. Bill creation with items
- Replace the single-total bill form with an item list editor: add/edit/remove item rows (name, price, optional quantity), reorderable, running subtotal, tax/tip/fee/discount controls, and a **mismatch warning** when items + charges ≠ entered total (per SPEC §9) — allow saving anyway with the warning acknowledged, since receipts are messy.
- Keep a "Quick split" toggle that collapses to the Phase 1 single-amount flow for lazy entries. Both paths produce the same data shape.
- **Checkpoint B: commit.**

### 3. Assignment interface (SPEC §10 — put real design effort here)
- On bill detail, each item row: name, price, qty, assigned member chips (avatar + name, color-coded consistently per member within a group), per-person share, status badge (Assigned / Unassigned), edit assignment action.
- Assignment editor (bottom sheet on mobile, dialog on desktop): member multi-select, split-type selector with progressive disclosure — Equal is default and needs zero extra input; Percentage / Ratio / Custom reveal their inputs only when chosen.
- Live validation as the user types: percentages must total 100 (show running total and the gap), custom amounts must total the item price (show remaining), ratios must be positive integers. Disable save until valid; error text says exactly what's wrong.
- Live preview: each selected member's computed share for THIS item, updating per keystroke.
- Bill-level assignment progress bar ("7 of 9 items assigned") and an Unassigned filter chip. A bill with unassigned items shows a warning on bill detail and contributes only its assigned items to balances.
- Bulk helper: "Assign all unassigned items equally to everyone" single action.
- **Checkpoint C: commit** — I'll test the full assignment flow on my phone before you continue.

### 4. Explainability surfaces (SPEC §2.1, §3.3)
- Bill detail "How was this calculated?": per member — their items with shares, their charge allocations (with the proportion shown, e.g. "your items were 40% of the subtotal, so 40% of tax"), rounding note when remainder paise were distributed, total.
- Balance detail (person-to-person): outstanding amount, then per contributing bill an expandable card: the items driving that bill's contribution, each with split method and share. A friend must be able to answer "why do I owe ₹613?" in under 10 seconds from this screen.
- Activity page expandable cards: itemized breakdown with per-person contribution bars (SPEC §11).
- Plain language everywhere: "You had the pasta (₹450, just you) and shared the pizza (₹600 ÷ 3 = ₹200)". No jargon.
- **Checkpoint D: commit + tag `v0.2` + deploy.**

## Out of scope
OCR, receipt images, settlements, any change to auth/groups beyond what assignment needs.

## Definition of done — I will personally verify
- [ ] Checks, tests, build pass; migration verified against live Phase 1 data (snapshot comparison shown to me).
- [ ] Restaurant scenario: 5 items, one item only mine, one shared by 3 equally, one 60/40 percentage, one custom amounts, one 2:1 ratio; plus tax and tip. Every person's total matches my hand calculation (I will actually hand-calculate this).
- [ ] Percentages that don't reach 100 cannot be saved; the UI tells me the gap.
- [ ] Custom amounts that don't sum to item price cannot be saved; the UI shows remaining.
- [ ] A bill with 2 of 5 items unassigned: warning visible, balances reflect only assigned items, dashboard flags it.
- [ ] "How was this calculated?" on balance detail traces one balance to bills to items convincingly — I'll show it to my wife cold and she should understand it without me explaining.
- [ ] Assignment flow fully usable one-handed on my phone.
- [ ] All Phase 1 checklist items still pass (regression).

# PHASE 3 — Registered-only members, invite-first flow, bill-creation rework

Read `CLAUDE.md` and SPEC.md sections 3.5, 5, 8, 9, 10 before planning. Phases 1–2 are live with real data and real users, some of whom are currently name-based (unlinked) members — this phase changes that model going forward and must not orphan or silently break anyone already in the database.

**This phase is an explicit, approved change to project scope**, made after live usage exposed real friction:
- CLAUDE.md previously implied name-based members as a permanent, first-class concept ("Support name-based members for casual use" — SPEC §3.5). The human has now decided every group member should end up a real, registered, linked account — an unlinked member is a *transient invited state*, never a permanent one. Treat this as authoritative, not a drift to push back on.
- This does **not** reopen "notifications/emails" as in-scope (still excluded per CLAUDE.md). Getting someone from "invited" to "joined" stays a manual, user-driven share (a link the group creator sends themselves, same mechanism Phase 1 already built) — the app never sends anything on anyone's behalf.

**Goal:** two changes, designed together because they touch the same screens —
1. Adding someone to a *group* is invite-link-only — no free-text name entry anywhere, at group-creation time or afterward. Adding someone to a *bill* only ever offers already-joined members.
2. Bill creation stops treating assignment as an afterthought: items default to being split among whoever's selected for the bill, with per-item overrides available inline, so the live preview and "who owes what" are visible the moment items exist — not after a separate trip to Bill Detail.

**First produce a numbered implementation plan for my approval, including exactly how existing name-based members and existing bills are handled (no schema drift without a plan). Do not write code until I approve.**

## Scope

### 1. Invite-only member model — ✅ shipped (revised)
Superseded the original draft below after discussion: rather than keeping free-text name entry as an "invited placeholder" affordance, it's removed entirely — the only ways to add anyone to a group are (a) the invite link (with native share where supported), for someone not yet registered, or (b) direct search-and-add of an already-registered account by name/email/phone (added below in §3's revision) — never a free-text name. See the implementation plan this produced for the exact design reasoning and file-level changes; summary of what's live:
- `POST /api/groups` no longer accepts member names — a new group has exactly one member, the creator.
- The original free-text `POST /api/groups/:id/members` is removed; it's since been re-added with a fundamentally different contract (`{ userId }`, an already-registered account only — see §3's revision) — not a reopening of free-text entry. `InviteLinkCard` (now with Copy + Share) covers the not-yet-registered case, surfaced prominently on group detail alongside the new search box.
- Every bill-level member picker (Quick Split's payer/split-between, the itemized assignment editor, "assign all equally") filters to linked (`isLinked`) members only — structural now, not just a stopgap for legacy data.
- A group with only the creator linked shows an inline nudge ("It's just you here so far — invite others") with a one-tap copy-invite-link action, instead of an empty or broken picker.
- Existing unlinked members from before this shipped are untouched — same display, same "claim a slot" join flow, same balances. No migration, no schema change; the claim-a-slot code path simply goes unused for any group created from now on, since no new unlinked rows are ever created.

### 2. Bill creation: assignment by default, not by afterthought — ✅ shipped
- Itemize mode gained the same "Split equally between" member-selection step Quick Split already had. Every new item defaults to an **equal split among that full selection** the moment it's added — no more "items start unassigned."
- Per-item override is inline during creation: an "Edit split" action under each item row opens the same `AssignmentEditor` used on Bill Detail (reused, not duplicated), for the items that aren't a simple equal share — percentage/ratio/custom/excluding someone. Verified live: a two-item bill with one item overridden to a 60/40 split produced a correct live-preview total and, after saving, a correct per-person breakdown.
- Live preview now works for itemized bills too (`computeBillBreakdown` from `shared/lib`, fed the same default-or-overridden assignments used at submit time), since every item has a real assignment from the moment it's added.
- Bill Detail's "N of M assigned" progress bar, the unassigned-item warning banner, and "assign all equally" are removed — they existed to compensate for the old start-unassigned default. The per-item Assigned/Unassigned badge stays as a safety net for the rare case someone manually clears an item's assignees via the editor.

### 3. Optional personal (no-group) bills — ✅ shipped, then corrected — ✅ shipped
First shipped as a solo "Just me (personal)" expense tracker. Live UAT surfaced that this wasn't the actual ask: the real need was **bills involving specific real people, without a formal named group**, with those balances tracked and visible exactly like a group's — plus a way to add any already-registered person directly (search by name/email/phone), not limited to people already shared with via a group. Corrected design, now live:
- Added `users.phone` (nullable, unique) and a minimal "Edit profile" dialog (off the account menu) so a user can set one. `PATCH /api/auth/me` validates and normalizes it (digits + optional leading `+`).
- New `GET /api/users/search?q=` — matches partial name (fuzzy, since this is a small invite-only friend circle, not a public directory) or exact email/phone. New `GET /api/users/known` — everyone the requester shares any group with today, as a tap-to-add shortlist. Both power a shared `PersonSearch` component.
- `POST /api/groups/:id/members` (removed in §1) is back with a different contract: `{ userId }` only, never a free-text name — any existing member can add an already-registered account directly, surfaced on Group Detail next to the invite link (which now covers only the not-yet-registered case).
- The bill form's Group picker gains **"No group — select people"** in place of "Just me". Choosing it reveals a people-picker (known-people shortlist + `PersonSearch`), and everything downstream — payer, default-equal-split, per-item overrides, live preview — runs through the exact same `computeBillBreakdown`/`AssignmentEditor`/`ItemListEditor` machinery a real group uses, just keyed by userId instead of memberId until the server resolves a real group. Selecting only yourself reproduces the original solo behavior exactly, as the same code path's 1-person case — no separate "personal" branch remains.
- Server-side, `getOrCreateSharedGroupId` (generalizing the original single-person helper) resolves-or-creates a hidden group for the exact participant set, reusing it for future bills with that same set, auto-naming it from participants' display names (still literally "Personal" for the solo case). This is less special-casing than the original forced-equal-split-only version, not more.
- `GET /api/groups` already excluded hidden groups from the list (no change needed); `GET /api/balances` already aggregates every group a user belongs to regardless of visibility (no change needed) — an individual bill's balance shows up in Balances / the per-person drill-down automatically, with no new balance code. Bill Detail's group-name header is plain text (not a link) for a hidden group, since there's no group page for it.
- Verified live end-to-end: a 3-person itemized individual bill (equal + percentage-override items) produced correct per-person shares, showed correctly in both directions' Balances drill-down, and was excluded from the Groups list; a solo individual bill reused the same lazily-created "Personal" group across two separate bills; editing an existing individual bill needed no special handling.
- **Caught and fixed during this verification**: the "Paid by" `<Select>`'s `onValueChange` did `setPayerMemberId(Number(v))` with no guard — Radix can fire it with `v=""` when the controlled value briefly doesn't match any rendered item (happens for one render while individual-mode's participant list populates), and `Number("")` is `0`, silently corrupting the payer to an invalid id. Fixed by ignoring non-positive-integer values in that handler.
- **Checkpoint C: commit + tag `v0.3` + deploy.**

## Out of scope
Any actual notification/email/SMS sending, the visual redesign (Phase 4 — this phase's new flows should be functionally complete but don't need to look final), OCR, settlements, debt simplification.

## Definition of done — I will personally verify
- [x] Checks, tests, build pass. (§1 shipped and verified — see conversation for local + verification detail.)
- [x] Every currently-live group and bill still loads correctly and shows the same balances as before this phase.
- [x] There is no way to add someone to a group by typing a name, anywhere — only the invite link. A legacy unlinked member still displays correctly and can still claim their slot via the same invite link.
- [x] Trying to assign a bill item or set a payer only ever offers joined members — an unlinked/legacy member cannot be picked, verified against a seeded legacy member in a live group.
- [x] Creating an itemized multi-item bill in one sitting produces correct, complete balances with no separate assignment step, and I can override one item's split inline during creation.
- [x] I can create a bill with no group chosen (with specific people, or just myself) and it doesn't show up anywhere I didn't expect (no group list, no other member's view) — verified live with both a solo and a 3-person individual bill.
- [x] Phase 1 + 2 regression checklists still pass. (`npm run check`/`test`/`build` all clean; existing group-bill and personal-bill flows re-verified live.)

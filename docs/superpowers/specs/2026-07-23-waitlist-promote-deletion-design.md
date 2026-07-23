# Waitlist: delete the manual promote path (FIFO-only)

**Date:** 2026-07-23
**Status:** Approved (issue #45; FIFO-only decision and the DELETE-branch
sub-decision approved by Ivo — recorded below)

## Problem

`POST /api/waitlist/[id]/promote` lets a teacher promote a *chosen* waiting
entry — a manual queue-jump. It has no UI on any layer (teacher class detail
shows only a waitlist *count*, never the entries) and no HTTP test. The docs
deliberately spec the waitlist as **fully automatic** (product-concept §2:
auto-promote the queue head before the cancel deadline, first-come-claim in the
final hour, frozen after the deadline). Manual promotion is promised nowhere.

## Decision

**FIFO-only.** Manual promotion of a specific entry is removed — a "promote
this person" override cuts against the fair-FIFO positioning, and automation is
the whole story. Removal, which is *moderation* rather than a queue-jump, is
untouched.

## Scope

Two artifacts change:

1. **Delete** `src/app/api/waitlist/[id]/promote/route.ts` in full. It is the
   only caller of `promoteNext`'s `entryId` path.
2. **Simplify `promoteNext`** in `src/services/waitlist.ts`: drop the `entryId`
   option and its branch — both the explicit-entry lookup and the stale-chosen-
   entry handling (the `candidate` block that marks an already-registered chosen
   entry `removed`, reorders, and throws). The signature becomes
   `promoteNext(db, classId, opts: { now?: Date } = {})`, leaving only the
   queue-head loop, which *is* the automation. Update the JSDoc to drop the
   "with `entryId`, that specific entry is promoted" clause.

## Deliberately kept

- **`DELETE /api/waitlist/[id]` — both branches, untouched.** Removing an entry
  is legitimate teacher moderation, orthogonal to FIFO fairness, and already
  covered by integration tests (`registrations-api.test.ts`: "the class teacher
  can remove any entry", "a different teacher is denied", "a student cannot
  remove someone else's entry"). The teacher branch stays **API-only, tested,
  no UI** — a knowingly dormant capability, not dead code. A teacher-facing
  "remove waitlister" UI, if ever wanted, is a separate feature (the class page
  would first need to render the entries at all).
- **`WaitlistPromotionError`** — still thrown by the queue-head path and caught
  by the claim route (`waitlist/claim/route.ts`) and the auto-promote sweep.
- **Student self-removal** (`WaitlistEntryActions` → `DELETE`), and all waitlist
  tests. The `promoteNext (DB)` service tests already call the queue-head path
  (`promoteNext(prisma, classId)` with no `entryId`), so none need editing.

## Test impact & verification

No tests are added or removed — this deletes untested code, and nothing exercises
the `entryId` branch or the promote route. Inverted-TDD applies: the gate is that
the existing suite stays green after removal, not a new failing test first.

Verification:
- `tsc --noEmit` clean — catches any missed caller of the removed `entryId` option.
- `eslint` clean — catches now-unused imports/helpers (e.g. confirm
  `hasActiveRegistration` / `reorderWaitingEntries` remain used by the queue-head
  path and elsewhere).
- Full `vitest` + Playwright suite green — the auto-promote e2e
  (`student-journey.spec.ts`: "a freed seat auto-promotes the waiting student")
  and the DELETE authorization tests still pass.
- A `POST` to the removed route now returns 405 (Next.js — no handler).

## Out of scope

- Any teacher waitlist-management UI (view/remove entries on class detail).
- The `DELETE` endpoint and its tests.
- Docs changes: the automation story in product-concept §2 is already complete
  and correct — deleting the manual path makes the build *match* it, so no doc
  edit is required.

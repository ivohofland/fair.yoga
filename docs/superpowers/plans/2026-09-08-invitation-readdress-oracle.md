# Plan: close the PUT re-address oracle (#500)

Spec: `docs/superpowers/specs/2026-09-08-invitation-readdress-oracle-design.md`

Single task — the guard, its CAS, its shared refusal, and its tests are one
cohesive change; splitting them would separate a pre-check from the CAS that
has to move with it. No whole-branch review needed for a single-task plan.

## Task 1: Refuse `PUT` on a non-pending invitation, sharing the refusal `resend` already uses

**Files:**
- `src/app/api/invitations/[id]/shared.ts`
- `src/app/api/invitations/[id]/route.ts`
- `src/app/api/invitations/[id]/resend/route.ts`
- `tests/integration/invitations-api.test.ts`

**Behavior:**

1. In `shared.ts`, add a `NOT_PENDING` export next to `NOT_FOUND` and
   `DECLINED`: `respondError('This invitation is no longer pending.', 409,
   'NOT_PENDING')`, with a docblock stating it is the one answer both `PUT`
   and `resend` give a row that is neither `pending` nor `declined` (i.e.
   `accepted`) — the same "one sentence, one place" rationale `DECLINED`'s
   own docblock states.
2. In `route.ts`'s `PUT` handler, add `if (invitation.status !== 'pending')
   return NOT_PENDING();` immediately after the existing `declined` check.
3. In the same handler, narrow the `updateMany`'s `where` from `{ id, status:
   { not: 'declined' } }` to `{ id, status: 'pending' }`.
4. In `casMatchedNothing` (`route.ts`), add a branch: if the re-read finds
   `observed.status === 'accepted'`, return `NOT_PENDING()`. Rewrite its
   docblock's "matches nothing for TWO reasons" to state three (declined,
   accepted, or gone) — keep the existing `resolveInvitationOnLink`
   race-within-a-race paragraph, which is about the `declined` branch
   specifically and is unaffected by widening the CAS.
5. Replace the `OPEN SECURITY ISSUE: #500` docblock on the `PUT` handler with
   one stating the closed property in the present tense — match the voice
   of `resend`'s own docblock on the equivalent check, not a "this used to
   be open" narrative.
6. In `resend/route.ts`, replace the inline `respondError('This invitation is
   no longer pending.', 409, 'NOT_PENDING')` with the new shared
   `NOT_PENDING()` — pure dedup, no behavior change.

**Tests (write first):**

1. `PUT` on a seeded `accepted` row → `409` / `NOT_PENDING`, row untouched
   (mirror the existing declined test's shape, including its
   nothing-moved assertion).
2. CAS race: a row `pending` at the read, `accepted` by the time of the
   write (hook the read or the `updateMany` the way
   `invitations.gate.test.ts` hooks `student.findUnique`) → the write must
   not land. Prove this test is mutation-sensitive: temporarily revert the
   CAS to `{ not: 'declined' }`, confirm the test fails, restore.
3. Comparative oracle test: run the PUT-then-POST two-call sequence once for
   a linked-and-private student's guessed address and once for a stranger's,
   each against its own fresh `accepted` decoy invitation. Assert both `PUT`
   responses are equal (`409`/`NOT_PENDING`) and both `POST /api/students`
   responses are equal apart from `id` — same shape as
   `invitations.gate.test.ts`'s "answers a gated linked-unshared student the
   same as a genuine stranger" test: pin one side, derive the other via the
   comparison, no restated literal on both sides.
4. Prove the pre-check itself is load-bearing: temporarily remove the
   `NOT_PENDING` pre-check in `PUT`, confirm test 1 fails (the CAS narrowing
   alone would 409 with `CONTACT_CHANGED`/generic-409 rather than
   `NOT_PENDING`, which is a real behavior difference on the direct,
   non-race path), restore.
5. Confirm `resend`'s existing "refuses a non-pending row that is not
   declined" test keeps passing unedited after the `shared.ts` dedup.

**Verification:** `npx vitest run --project integration
tests/integration/invitations-api.test.ts`, plus `npm run verify`'s
non-integration projects (typecheck/lint/unit/components) from this
worktree. Integration and e2e as a whole are CI's job per this project's
worktree limitation — cite the CI run in the PR body, not a local `verify`,
for that tier.

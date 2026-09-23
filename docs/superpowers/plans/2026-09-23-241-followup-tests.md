# #241 follow-ups — two tests PR #656 left out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tests only. Pin the two behaviours PR #656 named as unheld:
`DELETE /api/account`'s teacher-only 503 `ERASURE_BUSY` branch, and the
`status: 'waiting'` re-check in `withdrawWaitingEntriesForTeacher`'s
`updateMany` against a promotion that commits while the withdrawal waits.

**Architecture:** Same shape as #656: each test beside its nearest sibling, each
guard broken on purpose by a named mutation, failure recorded, restored.

**Spec:** none — follow-up to `2026-09-23-lock-timeout-busy-paths.md`, whose
Global Constraints apply unchanged (4s hold, in-hold assertion, mutation
protocol, Comment Discipline, full cleanup).

## Why each is unheld today

- **Teacher-only `ERASURE_BUSY`.** `account-api.test.ts` covers student-only
  `ERASURE_BUSY` (transient branch, `half: 'student'`), teacher-only
  `ERASURE_FAILED` (non-transient, `half: 'teacher'`) and, since #656,
  `PARTIAL_ERASURE_BUSY`. The cell transient × teacher × not-partial is the one
  no test reaches: its message carries the teacher `stateNote` (the "closed and
  billed" sentence) inside the retry wording.
- **The `updateMany` re-check.** #656's M1 (drop `status: 'waiting'` from the
  `updateMany`) was inert because the single-transaction test never lets the
  entry's status change between the lock query and the update. In READ
  COMMITTED, a `FOR UPDATE OF c` that waited re-checks only the locked `Class`
  row (EvalPlanQual); the joined `WaitlistEntry` row is taken from the
  statement's original snapshot, so an entry promoted by the transaction it
  waited on still reads `waiting` and its class still lands in `classIds`. The
  `updateMany` is a new statement with a fresh snapshot — its filter is the
  only thing standing between that promoted entry and `removed`.

---

### Task 1: teacher-only `ERASURE_BUSY`

**Files:** Modify `tests/integration/account-api.test.ts` — beside "reports
ERASURE_BUSY with retry advice when the erasure loses a lock race".

- [ ] **Step 1: Write the test.** `seedTeacherOnly(label)`; give the teacher
  one `open` 2099 class (room/teacherRoom/class ids pushed onto the file's
  cleanup arrays, as the siblings do). Hold its `Class` row `FOR UPDATE` 4s
  (flag `holderReleased`), settle ~200ms, `DELETE /api/account`. Assert: 503;
  `body.error.code === 'ERASURE_BUSY'`; message matches `/again/i` AND
  `/closed and billed/` (the teacher `stateNote`, which the student-only
  sibling cannot show); `holderReleased` false at response;
  `teacher.deletedAt` null. `await holder` in `finally`.
- [ ] **Step 2: Run** the file with `--project integration` — PASS. **Commit.**
- [ ] **Step 3: Mutations** (warm `/api/account` after each):
  - M1: in `src/app/api/account/route.ts` `erasureFailure`, change
    `const transient = isTransientDbError(err) || err instanceof ErasureLockSetError;`
    to `const transient = false;` → expect 500 / `ERASURE_FAILED`.
  - M2: in the same function, change `opts.half === 'student'` to
    `opts.half !== 'student'` → expect the `/closed and billed/` assertion
    to fail.
  Record; restore; `git status` clean.

### Task 2: the `updateMany` re-check under a concurrent promotion

**Files:** Modify `src/services/waitlist.test.ts` — a new describe beside #656's
"withdrawWaitingEntriesForTeacher (#241)" describe, with its own fixture.

- [ ] **Step 1: Write the test.** Fixture: teacher T, one open 2099 class C,
  student S `waiting` at position 1 in C. Spy on `lockClassRowsOrdered` to
  capture the ids it returns (the #453 describe's `captureLockSets` pattern).
  1. Holder transaction: `SELECT … FROM "Class" WHERE id = C FOR UPDATE`, then
     update S's entry in C to `promoted`, then sleep ~800ms (well under the
     2s bound), set `holderCommitting = true`, return.
  2. Settle ~150ms, then run
     `prisma.$transaction((tx) => withdrawWaitingEntriesForTeacher(tx, { teacherId: T, studentId: S }))`
     and await it, then await the holder.
  Assert: the captured lock set is `[[C]]` — proof the withdrawal's lock
  query waited on C and still selected it from its pre-wait snapshot (if it
  is `[[]]`, the race window was missed and the test proves nothing);
  S's entry in C is still `promoted`.
- [ ] **Step 2: Run** — PASS, three times in a row (timing test). **Commit.**
- [ ] **Step 3: Mutation** M3: drop `, status: 'waiting'` from the
  `updateMany` `where` in `withdrawWaitingEntriesForTeacher`
  (`src/services/waitlist.ts`) → expect `expected 'removed' to be 'promoted'`.
  This is #656's inert M1; it must bite here. Record; restore; clean.
  If the captured lock set comes back `[[]]` instead, stop and report — the
  EvalPlanQual premise above would be wrong.

## Measured results

(filled in as tasks complete)

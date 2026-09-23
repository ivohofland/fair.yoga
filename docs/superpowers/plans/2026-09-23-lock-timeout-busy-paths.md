# #241 — pin the busy paths #237 bounded — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tests only. Pin the four behaviours #241 names as unheld: a teacher-half
`55P03` aborts `deleteTeacherAccount` atomically and surfaces from
`DELETE /api/account` as 503 `PARTIAL_ERASURE_BUSY`; `DELETE
/api/teacher-links/[teacherId]` answers 503 under the same contention and leaves
the link standing; `withdrawWaitingEntriesForTeacher` withdraws every waiting
entry of the pair and nothing else; and `lockClassRowsOrdered` binds a value in
its `join` fragment in source order.

**Architecture:** No production code changes are expected. Each task adds tests
next to the nearest existing sibling, then proves each new assertion can fail
by applying a named mutation to production code, recording the exact failure,
and restoring.

**Tech Stack:** Vitest (`unit` project runs against the worktree's test DB;
`integration` project hits the worktree's dev server via
`INTEGRATION_BASE_URL`), Prisma, PostgreSQL.

**Spec:** none — a tests-only change with one obvious shape per item. The
premise check (below) is the design input.

## Premise check (measured 2026-09-23, against `origin/main` 68b9cda1)

The issue was filed at #241; the tracker is past #650. Each claim re-derived:

1. **Teacher-half `55P03` — still a gap.** The only held-lock-past-2s tests
   are the student half's (`gdpr-lock-order.test.ts`, "bounds its wait even
   when the student is waiting in no classes at all") and the route's
   student-only `ERASURE_BUSY` (`tests/integration/account-api.test.ts`,
   "reports ERASURE_BUSY with retry advice when the erasure loses a lock
   race"). `PARTIAL_ERASURE_BUSY` appears only in `route.ts` and
   `api-error-codes.ts`: `grep -rn PARTIAL_ERASURE_BUSY src tests` → 2 hits,
   0 in tests. The partial test that exists forces a P2002 and pins the 500
   `PARTIAL_ERASURE` branch.
2. **`DELETE /api/teacher-links` busy — still a gap.** `reason-map.test.ts`
   mocks the service; `invitations-api.test.ts`'s "the unlink withdrawal takes
   the class lock" holds the class row for 1.5s (below the 2s bound) and calls
   the service, not the route — it proves a wait, never a timeout.
3. **`withdrawWaitingEntriesForTeacher` has no behavioural test — partly
   closed.** #453 added `waitlist.test.ts` "withdraws only this pair's entries,
   and locks only their classes": one entry of the pair, one other-teacher
   entry, one other-student entry. Not held: more than one entry withdrawn,
   a non-`waiting` entry of the pair left alone, the survivors' positions
   compacted.
4. **`join` bound-value order — still a gap, and no call site exercises it.**
   Every `join:` passed in `src` is a static constant (`CLASS_TO_ENTRY_JOIN`,
   `CLASS_TO_WAITLIST_JOIN`, or both composed) —
   `grep -rn 'join:' src --include='*.ts' | grep -v '\.test\.'`. The docblock on
   `ClassLockSource.where` claims "merge … in source order, verified against
   Postgres"; the one composition test asserts `values` is `[]`.

## Global Constraints

- No production code changes. If a guard cannot be made to bite without one,
  stop and report rather than editing `src/` outside test files.
- Held-lock tests hold for **4s** (past the 2s `lock_timeout`, below Prisma's
  5s interactive default) and must assert the failure arrived **while the
  holder still held** (`holderReleased === false` at settle time). A held lock
  that outlives Prisma's own budget can fake the same 503 through `P2028`; the
  in-hold assertion is what rules that out.
- Every mutation is applied as exact text, run, recorded (failing assertion +
  message), restored, and `git status` shown clean before the next. Commit the
  task's tests before mutating (a `git checkout` restore eats uncommitted work).
- Integration tests run against the worktree's own server:
  `pnpm exec vitest run --project integration <file>`. After a mutation to a
  route or service, curl the route once before scoring (lazy recompilation).
- Comments annotate the code they sit on — no counts, no rosters, no history
  (CLAUDE.md, *Comment Discipline*).

## Review Focus

- A held-lock test passing because the request waited out the hold and then
  failed for another reason (P2028, a later constraint) — the in-hold
  assertion must exist in every held-lock test.
- A dual-account busy test where the student half, not the teacher half, hit
  the held row — assert the student half committed (`student.deletedAt` set).
- Fixture coupling in `invitations-api.test.ts`: the existing lock describe's
  test consumes the link; a new test sharing that fixture must not depend on
  running after it, nor leave state it depends on.
- A `join` bound-value test whose swapped-parameter result would be identical
  to the correct one (then it pins nothing about order).
- Cleanup: every row a new fixture writes is deleted in `afterAll`/`finally`,
  including an erased student's rows on the dual account.

---

### Task 1: `withdrawWaitingEntriesForTeacher` behavioural test

**Files:**
- Modify: `src/services/waitlist.test.ts` — inside or beside the describe
  "withdrawWaitingEntriesForTeacher locks only the pair it was given (#453)".

**Interfaces:** none produced.

- [ ] **Step 1: Write the test.** A fixture of its own (unique suffix, as the
  #453 describe does): teacher T with three open classes C1, C2, C3 dated 2099;
  another teacher T2 with class D; students S and O, S linked to T.
  Entries: C1 — S `waiting` pos 1, O `waiting` pos 2; C2 — S `waiting` pos 1;
  C3 — S `promoted` (any non-`waiting` status); D — S `waiting` pos 1.
  Call the function directly inside a transaction:

  ```ts
  await prisma.$transaction((tx) =>
    withdrawWaitingEntriesForTeacher(tx, { teacherId: teacherTId, studentId: studentSId }),
  );
  ```

  Assert: S's C1 and C2 entries are `removed`; S's C3 entry is still
  `promoted`; S's D entry is still `waiting`; O's C1 entry is `waiting` at
  position 1 (compacted from 2).

- [ ] **Step 2: Run it:** `pnpm exec vitest run src/services/waitlist.test.ts -t '<your test name>'` — PASS.
- [ ] **Step 3: Commit** the test.
- [ ] **Step 4: Mutations** in `src/services/waitlist.ts`, `withdrawWaitingEntriesForTeacher`'s `updateMany`, one at a time:
  - M1: delete `, status: 'waiting'` from the `updateMany` `where` → expect the C3 assertion to fail.
  - M2: replace `classId: { in: classIds }, ` with nothing → expect the D assertion to fail.
  - M3: delete the `for (const classId of classIds) { await reorderWaitingEntries(tx, classId); }` loop → expect the O-position assertion to fail.
  Record each failure; restore; `git status` clean.

### Task 2: `deleteTeacherAccount` aborts atomically on a teacher-half `55P03`

**Files:**
- Modify: `src/services/gdpr-lock-order.test.ts` — beside "bounds its wait
  even when the student is waiting in no classes at all".

- [ ] **Step 1: Write the test.** Fixture: a teacher (own account) with one
  `open` class dated 2099 (via `createClassFixture`), no templates, no
  in-progress classes (so the pre-transaction `completeClass` loop does
  nothing). Hold that `Class` row `FOR UPDATE` for 4s in another transaction,
  setting `holderReleased = true` when the hold ends; wait ~150ms; then:

  ```ts
  const outcome = await deleteTeacherAccount(prisma, teacherId)
    .then(() => 'returned' as const)
    .catch((err: unknown) => ({ error: String(err), holderReleased }) as const);
  await holder;
  ```

  (Use `deleteTeacherAccount`'s actual signature — read it in `gdpr.ts`.)
  Assert: `outcome` is not `'returned'`; its error matches
  `/55P03|lock timeout/`; `holderReleased` was false when it settled;
  `teacher.deletedAt` is null; the class's `CalendarEntry.cancelledAt` is still
  null (the erasure cancels upcoming classes, so this is the atomic-abort
  check on its own write). Clean up in `finally`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/services/gdpr-lock-order.test.ts -t '<name>'` — PASS.
- [ ] **Step 3: Commit.**
- [ ] **Step 4: Mutation** M4: in `src/lib/db-locks.ts`, make `setLockTimeout`
  return before issuing its statement → expect `outcome` to be `'returned'`
  (the erasure waits out the hold and succeeds). Record; restore; clean. If
  `gdpr.ts` sets the timeout by another route too, name which statement the
  mutation had to reach and report it.

### Task 3: the two routes answer 503 under a held lock

**Files:**
- Modify: `tests/integration/account-api.test.ts` — beside "reports
  ERASURE_BUSY with retry advice when the erasure loses a lock race".
- Modify: `tests/integration/invitations-api.test.ts` — inside "the unlink
  withdrawal takes the class lock (#166 whole-branch I4)".

- [ ] **Step 1: `PARTIAL_ERASURE_BUSY`.** Dual account via the file's
  `seedDual`. Give its **teacher** profile one `open` 2099 class (room +
  teacherRoom pushed onto the file's cleanup arrays, as the ERASURE_BUSY test
  does). The student profile has no registrations or entries, so the student
  half locks nothing the holder holds. Hold that class's row 4s (flag
  `holderReleased`), wait ~200ms, `DELETE /api/account` with the session.
  Assert: 503; `body.error.code === 'PARTIAL_ERASURE_BUSY'`; message matches
  `/again/i`; `holderReleased` false at response; `student.deletedAt` NOT null
  (the student half committed — proves the teacher half is what timed out);
  `teacher.deletedAt` null. `await holder` in `finally`.
- [ ] **Step 2: teacher-links 503.** New `it` in the I4 describe, **placed
  before** the existing test: that test ends with the link deleted, so this
  one needs the fixture's starting state. Hold `lockClassId` 4s (flag
  `holderReleased`), wait `SETTLE_MS`, `DELETE
  /api/teacher-links/${lockTeacherId}` with a session for
  `lockStudentAccountId` (`seedSession`). Assert: 503; message matches
  `/try again/i`; `holderReleased` false at response; the `TeacherStudent`
  row still exists; the waiting entry is still `waiting`; no `TeacherBlock`
  for the pair. `await holder`. Add a one-line comment saying why it must
  precede its sibling.
- [ ] **Step 3: Run** both files with `--project integration` — PASS.
- [ ] **Step 4: Commit.**
- [ ] **Step 5: Mutations**, warming the route after each:
  - M5: `src/app/api/account/route.ts`, in `erasureFailure`, change
    `const transient = isTransientDbError(err) || err instanceof ErasureLockSetError;`
    to `const transient = false;` → expect the PARTIAL_ERASURE_BUSY test to fail (500 / `PARTIAL_ERASURE`).
  - M6: `src/lib/db-locks.ts`, `setLockTimeout` no-op (M4) → expect the
    teacher-links test to fail (200 after the hold). Record; restore; clean.

### Task 4: `join` bound values merge in source order

**Files:**
- Modify: `src/lib/db-locks.test.ts` — inside `describe('lockClassRowsOrdered')`,
  using its live fixture (studentA waits on low and high; studentB on low).

- [ ] **Step 1: Write the test.**

  ```ts
  const locked = await prisma.$transaction((tx) =>
    lockClassRowsOrdered(tx, {
      join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id AND w."studentId" = ${studentBId}`,
      where: Prisma.sql`c.id IN (${lowClassId}, ${highClassId})`,
    }),
  );
  expect(locked).toEqual([lowClassId]);
  ```

  Swapped parameters would compare `studentId` to a class id and return `[]`,
  so the expectation distinguishes the orders. Adjust names to the fixture's.
- [ ] **Step 2: Run** `pnpm exec vitest run src/lib/db-locks.test.ts -t '<name>'` — PASS.
- [ ] **Step 3: Commit.**
- [ ] **Step 4: Mutation** M7: in `lockClassRowsOrdered`, replace
  `${source.join ?? Prisma.empty}` with
  `${Prisma.raw(source.join?.sql ?? '')}` (drops the join's values) → expect
  a Postgres bind-count/parameter error. Record; restore; clean.

---

## Measured results

The plan predicted M1 would fail the C3 assertion; it was inert instead — the
`status: 'waiting'` filter is held both by `lockClassRowsOrdered`'s pre-lock
predicate and by the `updateMany`, so dropping it from the `updateMany` alone
leaves the other copy still excluding C3 in a single-transaction test. The
plan predicted M7 would give a Postgres bind-count/parameter error; it gave a
`42601` syntax error instead, which is why the controller added M7'.

- **M1** (drop `, status: 'waiting'` from the `updateMany` `where`):
  inert — the C3 assertion still passed (`Tests 1 passed | 56 skipped (57)`),
  because `lockClassRowsOrdered`'s own `w.status = 'waiting'` predicate
  already keeps C3 out of `classIds` before the `updateMany` runs.
- **M1'** (drop `status: 'waiting'` from both `lockClassRowsOrdered`'s `where`
  and the `updateMany`'s `where`, together): failed —
  `AssertionError: expected 'removed' to be 'promoted'`
  (`expect(c3S.status).toBe('promoted')`).
- **M2** (drop `classId: { in: classIds }` from the `updateMany` `where`):
  failed — `AssertionError: expected 'removed' to be 'waiting'`
  (`expect(dS.status).toBe('waiting')`).
- **M3** (drop the `reorderWaitingEntries` loop): failed —
  `AssertionError: expected 2 to be 1`
  (`expect(c1O.position).toBe(1)`).
- **M4** (`setLockTimeout` returns before issuing its statement): failed —
  `AssertionError: expected 'returned' not to be 'returned'`
  (`expect(outcome).not.toBe('returned')`).
- **M5** (`erasureFailure`'s `transient` forced to `false`): failed —
  `AssertionError: expected 500 to be 503` (`account-api.test.ts`).
- **M6** (`setLockTimeout` made a no-op): failed —
  `AssertionError: expected 200 to be 503` (`invitations-api.test.ts`).
- **M7** (join spliced via `Prisma.raw(source.join?.sql ?? '')`, dropping its
  bound value): failed with a Postgres syntax error, not a bind-count error —
  `PrismaClientKnownRequestError: Raw query failed. Code: 42601. Message:
  ERROR: syntax error at or near "WHERE"`.
- **M7'** (join spliced via `Prisma.raw(source.join?.text ?? '')` instead,
  requested after M7 to isolate a binding-order failure): failed with a
  wrong result — `AssertionError: expected [] to deeply equal [ Array(1) ]`
  (`expect(locked).toEqual([lowClassId])`).

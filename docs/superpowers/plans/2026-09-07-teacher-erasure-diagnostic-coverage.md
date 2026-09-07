# Teacher-erasure post-commit diagnostic coverage (#407) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four test-coverage gaps issue #407 names in `deleteTeacherAccount`'s post-commit diagnostic loop (`src/services/gdpr.ts`) — none are live defects, all are mutations that currently pass the 29-test suite and shouldn't.

**Architecture:** Test-only change, one file (`src/services/gdpr.test.ts`), inside the existing `describe('deleteTeacherAccount cancels by compare-and-swap (#174)', ...)` block. No production code changes — `gdpr.ts` is already correct; every fix below is a missing or under-specified assertion.

**Tech Stack:** Vitest (`integration` project), Prisma (`$extends` query interception, real DB).

**Spec:** None — single-file, test-only change with no reasonable-design ambiguity once the four gaps are read against the existing sibling tests, so the brainstorming gate resolved straight to this plan per `solve-issue`'s spec gate (no changed invariant, no data model change, no money/auth design decision).

## Global Constraints

- **File:** every change in this plan lands in `src/services/gdpr.test.ts`, inside the `describe('deleteTeacherAccount cancels by compare-and-swap (#174)', ...)` block (currently lines 749–1179). Do not touch `src/services/gdpr.ts` — production code is not part of this issue; if you believe it needs a change, stop and report `NEEDS_CONTEXT` rather than editing it.
- **This is an `integration`-tier test file and CANNOT be executed in this worktree.** `gdpr.test.ts` uses a real `PrismaClient` against the shared dev database, and per this repo's own convention a worktree has neither the dev server nor a safe way to reach that database — `npx vitest run --project integration ...` will hang or fail with `ECONNREFUSED` here, and that is expected, not a sign your test is wrong. **Do not** try to start a database, point `DATABASE_URL` at anything, or debug a connection failure — verify your work with `npx tsc --noEmit` and `npx eslint src/services/gdpr.test.ts` only, then commit. The real pass/fail signal comes from CI after the branch is pushed (the controller handles that outside this task loop).
- **Match the file's existing test style exactly** — every test below is written out in full; use it verbatim rather than improvising a different shape. In particular: `onTestFinished(() => x.mockRestore())` immediately after every `vi.spyOn`; `createClassFixture` for class fixtures; the `lockClassRowsOrdered` spy-and-append pattern for injecting an id the real predicate would never match; one `expect.objectContaining({...})` per logged call (never split across two `toHaveBeenCalledWith` assertions on the same call).
- **Comment discipline (CLAUDE.md):** a comment may explain *why* a test is shaped the way it is (the mechanism it stages, the invariant it proves) but must never restate a count or a roster, and must never say "previously" or "this used to" — state only what's true now. Keep new comments as short as the existing sibling tests' comments; do not write new paragraphs longer than the shortest example already in the block above your insertion point.
- **Do not reorder or renumber existing tests.** Insert new tests at the exact locations named in each task.

---

### Task 1: `row-deleted` branch, `observedCancelledAt: null`, and combined assertions

**Files:**
- Modify: `src/services/gdpr.test.ts:935-942` (combine two split `warn` assertions into one, add `observedCancelledAt`)
- Modify: `src/services/gdpr.test.ts` — insert one new test immediately after line 943 (the closing `});` of `'warns and skips when a locked id turns out not to be cancellable'`) and before line 945 (`it('reports a CAS skip after commit...'`)

**Interfaces:**
- Consumes: `createClassFixture` (`tests/class-fixtures`), `dbLocks.lockClassRowsOrdered` (`@/lib/db-locks`), `log` (`@/lib/log`), `deleteTeacherAccount`/`AlreadyErasedError` (`./gdpr`), the describe block's shared `prisma`, `teacherId`, `teacherRoomId`, `waitingStudentId`, `registeredStudentId`.
- Produces: nothing consumed by Task 2 — the two tasks are independent edits to the same file.

- [ ] **Step 1: Edit the existing test's split assertions (lines 935-942)**

Replace this exact block:

```ts
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ classId, observedStatus: 'completed' }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ waitingEntriesLeft: 1 }),
      expect.anything(),
    );
```

with:

```ts
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        classId,
        observedStatus: 'completed',
        // Live and never cancelled — the `?? null` fallback for a
        // genuinely-uncancelled entry, untested until now (#407 item 3).
        observedCancelledAt: null,
        waitingEntriesLeft: 1,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
```

This closes #407 items 3 and 4 together: `observedCancelledAt` is now asserted (the class in this fixture is live and was never cancelled, so the real value is `null`, not a fallback), and all four fields are now pinned on the *same* logged call instead of two separate `toHaveBeenCalledWith` calls that could each match a different invocation.

- [ ] **Step 2: Insert the new `row-deleted` test**

Insert this test as a new sibling, immediately after the test you just edited (after its closing `});` at what is currently line 943) and before `it('reports a CAS skip after commit...'`:

```ts
  it('reports row-deleted when the class row is gone by the time the diagnostic reads it', async () => {
    // Completed and ineligible, exactly like the sibling test above — the
    // only difference this test adds is deleting the row for real between
    // commit and the diagnostic read, so `observed` comes back `null`
    // rather than throwing. `row-deleted` is the `?? 'row-deleted'`
    // fallback's own branch, reachable since #242 moved this read after the
    // transaction's locks release (#407 item 1).
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'row-deleted class',
      date: new Date('2026-06-03'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
    });
    const classId = cls.id;
    const calendarEntryId = cls.calendarEntry.id;

    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => spy.mockRestore());

    // Deletes the row for real, inside the diagnostic's own `findUnique`
    // call, then lets the real query run — it returns a genuine `null`,
    // not a mocked one. `CalendarEntry` cascades to `Class` (and to its
    // `WaitlistEntry`), so the residual queue this row held is gone with
    // it — `waitingEntriesLeft` below is 0 for that reason, not because
    // the count read failed.
    const rowDeleting = prisma.$extends({
      query: {
        class: {
          async findUnique({ args, query }) {
            if ((args.where as { id?: string }).id !== classId) return query(args);
            await prisma.calendarEntry.delete({ where: { id: calendarEntryId } });
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(deleteTeacherAccount(rowDeleting, teacherId)).resolves.toBeUndefined();

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        classId,
        observedStatus: 'row-deleted',
        observedCancelledAt: null,
        waitingEntriesLeft: 0,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
  });
```

- [ ] **Step 3: Verify statically (cannot execute — see Global Constraints)**

Run: `npx tsc --noEmit` and `npx eslint src/services/gdpr.test.ts`
Expected: both clean. Do not attempt `vitest run --project integration`.

- [ ] **Step 4: Commit**

```bash
git add src/services/gdpr.test.ts
git commit -m "test(gdpr): cover row-deleted diagnostic branch and pin observedCancelledAt (#407)"
```

---

### Task 2: return-vs-capture invariant (a skip must not survive a rolled-back erasure)

**Files:**
- Modify: `src/services/gdpr.test.ts` — insert one new test as the last test in the `describe('deleteTeacherAccount cancels by compare-and-swap (#174)', ...)` block, immediately before its closing `});` (after the `'a diagnostic loop failure does not fail the already-committed erasure'` test).

**Interfaces:**
- Consumes: same as Task 1, plus `AlreadyErasedError` (already imported at the top of the file).
- Produces: nothing — final test in the file's build order for this plan.

**Context — why this test is shaped this way:** `gdpr.ts`'s docblock above `const skipped: string[] = [];` (inside the `deleteTeacherAccount` transaction) claims that *returning* `skipped` from the transaction callback — rather than pushing into a variable declared outside it — makes "logged a skip for an erasure that rolled back" unreachable. The only way to make one transaction attempt both (a) genuinely collect a skip and (b) roll back is to combine the existing `lockClassRowsOrdered`-injection trick (which stages a skip deterministically, as every sibling test in this block already does) with soft-deleting the teacher row *before* calling `deleteTeacherAccount`, so the same attempt's own final `teacher.updateMany({where: {deletedAt: null}, ...})` also matches zero rows and throws `AlreadyErasedError` — rolling back the whole transaction, including the class-level CAS write. With the current (return-based) code, `await db.$transaction(...)` itself throws, so the post-commit loop is never reached and no warn is ever logged for that class — this test pins exactly that. A mutant that hoists `skipped` to a variable this closure merely pushes into (and, necessarily, wraps the transaction call in its own try/catch to keep using that variable after the throw instead of letting it propagate) would still hold this class's id after the rollback — a JS-level array mutation is not undone by Postgres discarding the transaction's own writes — and would log the warn this test asserts against.

- [ ] **Step 1: Insert the new test**

Insert this test immediately before the closing `});` of the `describe('deleteTeacherAccount cancels by compare-and-swap (#174)', ...)` block (i.e., as the last test in that block):

```ts
  it('does not log a skip diagnostic for a class it collected before the erasure itself rolled back', async () => {
    // Same injection as the sibling tests above: the real predicate would
    // never match an already-`completed` row, so its id is only in
    // `upcoming` because the lock mock hands it back anyway.
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'rollback diagnostic class',
      date: new Date('2026-06-06'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
    });
    const classId = cls.id;

    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => spy.mockRestore());

    // Stages the losing half of a concurrent double-erasure directly,
    // rather than actually racing two calls: soft-delete the teacher up
    // front, so THIS SAME transaction attempt both collects the class
    // above as a skip AND then fails its own `teacher.updateMany` CAS
    // (`erased.count === 0`) — the shape #407 item 2 names.
    await prisma.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    const err = await deleteTeacherAccount(prisma, teacherId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyErasedError);
    expect((err as AlreadyErasedError).half).toBe('teacher');

    // The whole transaction rolled back, including the class's own CAS
    // write — not just the caller-visible teacher row.
    const after = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: { calendarEntry: true },
    });
    expect(after.status).toBe('completed');
    expect(after.calendarEntry.cancelledAt).toBeNull();

    expect(warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ classId }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
  });
```

- [ ] **Step 2: Verify statically (cannot execute — see Global Constraints)**

Run: `npx tsc --noEmit` and `npx eslint src/services/gdpr.test.ts`
Expected: both clean. Do not attempt `vitest run --project integration`.

- [ ] **Step 3: Commit**

```bash
git add src/services/gdpr.test.ts
git commit -m "test(gdpr): pin the return-vs-capture invariant on a rolled-back skip (#407)"
```

---

## Post-implementation verification (controller, not a task — outside the SDD loop)

Because this whole plan cannot be exercised locally (see Global Constraints), the controller must, after both tasks are complete and before opening the PR:

1. Push the branch and let CI's `test-integration` job run all four new/edited assertions for real — this is the first genuine execution of any of this plan's tests.
2. Separately (scratch branch off the same commit, deleted afterward, never merged): apply the postulated mutation to `gdpr.ts` — hoist `const skipped: string[] = [];` above `db.$transaction(...)`, have the callback push into it directly instead of a locally-scoped array, drop the `return skipped;`, and wrap the `db.$transaction(...)` call in a `try { ... } catch (err) { if (!(err instanceof AlreadyErasedError)) throw err; }` so the post-commit loop still runs over the hoisted array after a rollback — push it, confirm Task 2's new test fails in CI, record the exact failure text, then delete the scratch branch without merging it anywhere.
3. Record both results (the real CI run, and the mutation's CI failure text) in the PR body as the "Prove every guard bites" evidence for item 2.

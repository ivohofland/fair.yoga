# Erasure diagnostic moves post-commit (issue #242) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `deleteTeacherAccount`'s CAS-skip diagnostic unable to fail the erasure it describes, by moving its two reads out of the interactive transaction to after the commit — not by `.catch()`-guarding them in place, which issue #242 proposes and which is measurably worse than doing nothing.

**Architecture:** The `$transaction` callback returns the list of class ids whose cancel CAS matched nothing. After the transaction commits, `deleteTeacherAccount` loops that list, performs the same two reads against `db` (not `tx`) with `.catch()` sentinels, and emits the same `log.warn`. This is the shape `deleteStudentAccount` in the same file already has (`gdpr.ts:329` returns `freedClassIds`, `gdpr.ts:867` consumes it post-commit).

**Tech Stack:** TypeScript strict, Prisma 6 interactive transactions, Postgres, Vitest (`unit` project, `ethical_yoga_test` database).

**Spec:** None — bounded single-function change. The premise correction that replaces a spec is in this header and in Task 2's docs section; issue #242 itself proposes a different fix, and the reason it is not taken is recorded below.

## Why the issue's own fix is not what this plan implements

Issue #242 asks for `.catch(() => 'unread' as const)` / `.catch(() => -1)` on the two reads **in place**, inside the transaction. Measured against `ethical_yoga_test` on 2026-09-02, that does not work:

```
server-error-then-raw-read:   THREW P2010 :: Raw query failed. Code: `25P02`.
                              `current transaction is aborted, commands ignored…`
server-error-then-model-read: THREW PrismaClientUnknownRequestError ::
                              PostgresError { code: "25P02", … }
control (no failure):         OK -> 1
```

Both cases caught the failing statement and still died on the **next** one. Postgres aborts the whole transaction at the first statement error and Prisma issues no per-statement `SAVEPOINT`, so a JavaScript `.catch()` hides the cause without saving the transaction. `src/services/rule-lifecycle.test.ts:389-393` already states this in a comment ("Every later statement raises `25P02` until rollback").

The consequence of applying it anyway, traced through `src/lib/api-errors.ts:195` (`TRANSIENT_SQLSTATES = ['40001', '40P01', '55P03']`) and `:207` (`TRANSIENT_PRISMA_CODES = {P2024, P2028, P2034}`): `25P02` is in neither set, so `isTransientDbError` flips from `true` (for the `55P03` the read would have thrown) to `false`. `erasureFailure` (`src/app/api/account/route.ts:63`) then answers **500 `ERASURE_FAILED`** — "Pressing Delete again will not fix it — please contact support" — where today it answers **503 `ERASURE_BUSY`** — "Wait a moment, then press Delete again."

Census supporting "this would be the first of its kind": 16 non-test `.catch(` sites exist in `src/`; every one was read. Two sit on a whole `$transaction(…)` promise (`invitations.ts:690`, `:897`), one on a `Promise.all` of two `db.` reads (`entry-generation.ts:1158`), the rest on `db`/`prisma`/`fetch`/client code. **Zero sit on a `tx.` statement.** Re-derive with:

```sh
grep -rn "\.catch(" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types.
- Comment Discipline (CLAUDE.md): a comment annotates the code it sits on. The cross-module fact about `25P02` goes in `docs/lock-order.md` (Task 2) and the code comment links to it. No prose counts or rosters in comments. Correct a claim by **replacing** it, never by annotating it with what it used to say.
- Never edit an applied migration. This plan creates no migration.
- `gdpr.test.ts` belongs to the `unit` vitest project (`vitest.config.ts`), which runs against `DATABASE_URL_TEST` and needs **no** dev server. It runs locally in this worktree.
- Stage exact paths; never `git add -A` or `git add .`.

---

### Task 1: Move the CAS-skip diagnostic post-commit, and prove it cannot fail the erasure

**Files:**
- Modify: `src/services/gdpr.ts` — `deleteTeacherAccount`, the `$transaction` call opening at `:1006`, the CAS-skip branch at `:1245-1291`, and the function tail after the transaction's closing `);`
- Test: `src/services/gdpr.test.ts` — new `it()` inside the existing `describe('deleteTeacherAccount cancels by compare-and-swap (#174)', …)` block (starts `:1305`), which already provides the `teacherId`, `teacherRoomId`, `registeredStudentId`, `waitingStudentId` and `createClassFixture` fixtures

**Interfaces:**
- Consumes: nothing from another task.
- Produces: nothing another task imports. Task 2 cites the final code shape in prose and must match what lands here; the doc heading Task 1's comment links to is fixed below as **"A diagnostic read inside an interactive transaction cannot be guarded (issue #242)"**.

- [ ] **Step 1: Write the failing test**

Add this as a new `it()` at the end of the `describe('deleteTeacherAccount cancels by compare-and-swap (#174)', …)` block in `src/services/gdpr.test.ts`, immediately after the existing `it('leaves a class that completed after the erasure read alone, and still erases', …)`.

Two hooks do two different jobs and must not be conflated: the `class.findMany` hook stages the genuine CAS miss (copied from the sibling test above it, whose long comment explains why it discriminates on the `status` args shape rather than on call order), and the `class.findUnique` / `waitlistEntry.count` hooks make the diagnostic reads fail.

```ts
  it('reports a CAS skip after commit, so a failing diagnostic cannot roll the erasure back', async () => {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'diagnostic class',
      date: new Date('2026-06-02'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'in_progress',
    });
    const classId = cls.id;

    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // What the diagnostic read saw of the teacher row when it ran. Read on a
    // SEPARATE connection (the base `prisma`, not the extended client the
    // erasure is using), and a plain SELECT under READ COMMITTED never blocks
    // on the erasure's row lock — it returns the last COMMITTED version. So
    // an anonymized email here means the diagnostic ran AFTER the commit,
    // which is the whole of what #242 changes. Inside the transaction it
    // would read the original address: the erasure's own
    // `teacher.updateMany` is the last statement in that transaction, well
    // after this loop.
    let teacherEmailWhenDiagnosticRan: string | null = null;
    let completedConcurrently = false;

    const failing = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            const rows = await query(args);
            const status = (args.where as { status?: unknown } | undefined)?.status;
            const isTransactionRead =
              typeof status === 'object' && status !== null && 'in' in status;
            if (!isTransactionRead) {
              // The pre-transaction `in_progress` sweep. Hiding the row keeps
              // `completeClass` away from it, so it is genuinely still
              // `in_progress` for the transaction's own read below.
              return rows.filter((r) => r.id !== classId);
            }
            if (!completedConcurrently && rows.some((r) => r.id === classId)) {
              completedConcurrently = true;
              await prisma.class.updateMany({
                where: { id: classId },
                data: { status: 'completed' },
              });
            }
            return rows;
          },
          async findUnique({ args, query }) {
            if ((args.where as { id?: string }).id !== classId) return query(args);
            const teacher = await prisma.teacher.findUniqueOrThrow({
              where: { id: teacherId },
              select: { email: true },
            });
            teacherEmailWhenDiagnosticRan = teacher.email;
            throw new Error('injected: diagnostic status read failed');
          },
        },
        waitlistEntry: {
          async count({ args, query }) {
            if ((args.where as { classId?: string } | undefined)?.classId !== classId) {
              return query(args);
            }
            throw new Error('injected: diagnostic waitlist count failed');
          },
        },
      },
    }) as unknown as PrismaClient;

    // Resolves. A diagnostic that can reject the erasure is the defect.
    await expect(deleteTeacherAccount(failing, teacherId)).resolves.toBeUndefined();

    // The erasure committed.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    // And it had ALREADY committed when the diagnostic ran — the property
    // `.catch()` alone cannot deliver, because a caught statement error still
    // leaves a Postgres transaction poisoned (docs/lock-order.md).
    expect(teacherEmailWhenDiagnosticRan).toMatch(/@deleted\.invalid$/);

    // Both sentinels fired, and "could not look" stays distinct from "it was
    // gone" (`row-deleted`) and from "not cancelled" (`null`).
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        classId,
        observedStatus: 'unknown',
        observedCancelledAt: 'unknown',
        waitingEntriesLeft: -1,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );

    // The skip was real: the class kept the status the concurrent writer gave
    // it, and its queue was not closed.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('completed');
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: waitingStudentId } },
    });
    expect(entry.status).toBe('waiting');
  });
```

If `hhmmToTime`, `log`, `vi`, `onTestFinished`, `PrismaClient` or `createClassFixture` are not already imported in this file, they are — the sibling test above uses every one of them. Do not add imports without checking.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t 'so a failing diagnostic cannot roll the erasure back'`

Expected: FAIL. Against today's code the reads are inside the transaction, so the injected `Error('injected: diagnostic status read failed')` propagates out of `deleteTeacherAccount` and the first assertion (`resolves.toBeUndefined()`) fails. Record the exact message.

- [ ] **Step 3: Make the transaction return the skipped ids**

In `src/services/gdpr.ts`, change the transaction opening at `:1006` from

```ts
  await db.$transaction(
    async (tx) => {
```

to

```ts
  const skippedClassIds = await db.$transaction(
    async (tx) => {
      // Collected, not logged, inside this transaction — see the loop below
      // this call for why the diagnostic that explains each id cannot run
      // here. RETURNED rather than pushed into a variable this closure
      // captures: the value then exists only if the transaction committed,
      // so "logged a skip for an erasure that rolled back" is not a state
      // this function can reach. Same shape as `deleteStudentAccount`'s
      // `freedClassIds` above.
      const skipped: string[] = [];
```

and, immediately after the transaction's final statement (`if (erased.count === 0) throw new AlreadyErasedError('teacher');`), add:

```ts
      return skipped;
```

- [ ] **Step 4: Reduce the CAS-skip branch to a collect-and-continue**

Replace the whole `if (cancelled.count === 0) { … }` block (currently `src/services/gdpr.ts:1245-1291`) with the following. The `continue`-rationale prose stays here because it is about the `continue`; the diagnostic prose moves with the reads in Step 5. Do not leave a copy of it in both places, and do not write what either comment used to say.

```ts
        if (cancelled.count === 0) {
          // Skipping the CANCEL is the right handling: a completed class is
          // one erasure deliberately leaves standing (see this function's
          // docblock), so landing on one late is not an error, it is the
          // same outcome by a different route.
          //
          // Skipping SILENTLY was not. `count === 0` has four distinct
          // causes — the class completed concurrently, it was cancelled
          // concurrently, the row was deleted, or something nobody has
          // thought of — and a bare `continue` distinguished none of them,
          // emitted nothing, and returned `void`, so from outside this
          // function the difference between "erased 12 classes" and "erased
          // 12 classes and skipped one it could not explain" was invisible.
          // The id is collected here and the cause is read after this
          // transaction commits; the loop below the transaction says why the
          // read cannot happen here.
          //
          // This `continue` skips the waitlist sweep too, deliberately —
          // "does not touch the waitlist" is exactly what the test "leaves a
          // class that completed after the erasure read alone, and still
          // erases" pins, because a HALF-applied skip (CAS refused, waitlist
          // and notifications applied anyway) would tell a student their
          // class was cancelled after `completeClass` had already asked them
          // to pay for it.
          skipped.push(cls.id);
          continue;
        }
```

- [ ] **Step 5: Add the post-commit diagnostic loop**

After the transaction's closing `);` — the `{ timeout: 10_000 }` argument and its comment stay exactly as they are — and before `deleteTeacherAccount`'s closing brace, add:

```ts
  // The cause of each skipped cancel, read AFTER the commit.
  //
  // These two reads exist only to enrich the line below, and a diagnostic
  // must never be able to fail the operation it describes — the same rule
  // the `completeClass` loop above states. Inside the transaction that rule
  // is unreachable by any `.catch()`: Postgres aborts the whole transaction
  // at the first statement error and Prisma issues no per-statement
  // savepoint, so a guard there would swallow a retryable `55P03` and let
  // the next statement raise `25P02` instead — which `isTransientDbError`
  // does not classify, turning a 503 "try again" into a 500 "contact
  // support". Measured; see `docs/lock-order.md`, "A diagnostic read inside
  // an interactive transaction cannot be guarded (issue #242)". Out here the
  // erasure is committed and a failed read costs only the field it fills.
  //
  // What the reader gives up by reading late: another writer may move the
  // row between the CAS and this read. That was already true of the
  // in-transaction version — a class reaching this branch is one the
  // pre-lock did NOT hold, which is why the CAS missed it — so the reads
  // were never a locked observation to begin with.
  //
  // `waitingEntriesLeft` is the residual this skip leaves behind: any
  // `waiting` entry on a class that can never promote anyone, belonging to a
  // teacher who no longer exists. An operator seeing a non-zero count knows
  // there is a row to clean up, which is the whole difference between a
  // known residual and a silent one. Since #112 it carries a second meaning
  // — the happy path above NOTIFIES the queue as well as closing it, so a
  // non-zero count here is also "this many students heard nothing from this
  // path". That is tolerable only because every route that can produce the
  // three statuses `observedStatus` reports notifies the queue itself:
  // `completed` owes no cancellation notice, a concurrent `cancelled` came
  // from the manual route or `autoCancelClasses` (which tells them, since
  // #112), and `row-deleted` can only be `archiveOrUnarchiveTemplate` (which
  // tells them too). Add a fourth way for a class to leave
  // `draft|open|in_progress` and that argument is what breaks.
  for (const classId of skippedClassIds) {
    // `'unread'` kept distinct from a missing row and from a null
    // `cancelledAt`: conflating "we could not look" with "it was gone", or
    // with "it was not cancelled", is how a read failure gets filed as a
    // finding. `-1` is the same sentinel `deleteStudentAccount`'s
    // post-commit loop and `promoteAfterCancel`
    // (`api/registrations/[id]/route.ts`) use, and carries the same blind
    // spot: the error itself is discarded.
    const observed = await db.class
      .findUnique({
        where: { id: classId },
        select: { status: true, calendarEntry: { select: { cancelledAt: true } } },
      })
      .catch(() => 'unread' as const);
    const waitingEntriesLeft = await db.waitlistEntry
      .count({ where: { classId, status: 'waiting' } })
      .catch(() => -1);
    log.warn(
      {
        teacherId,
        classId,
        // Both halves, because neither answers alone any more: a concurrent
        // cancellation leaves `status` untouched and only `cancelledAt`
        // shows it.
        observedStatus: observed === 'unread' ? 'unknown' : (observed?.status ?? 'row-deleted'),
        observedCancelledAt:
          observed === 'unread' ? 'unknown' : (observed?.calendarEntry.cancelledAt ?? null),
        waitingEntriesLeft,
      },
      'teacher erasure: class cancel CAS matched nothing',
    );
  }
```

- [ ] **Step 6: Run the new test and the whole file**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`

Expected: PASS, all tests in the file. The sibling test at `:1387` asserts `observedStatus: 'completed'` and `waitingEntriesLeft: 1`; both still hold post-commit (the class stays `completed`, the entry stays `waiting`). Its `expect(calls).toBe(2)` counts `class.findMany` only and is untouched by this change. If either fails, that is a real finding — report it rather than adjusting the assertion.

- [ ] **Step 7: Mutation 1 — prove the `.catch()` bites**

Delete `.catch(() => -1)` from the `waitlistEntry.count` in the new loop. Run:

`npx vitest run --project unit src/services/gdpr.test.ts -t 'so a failing diagnostic cannot roll the erasure back'`

Expected: FAIL — the injected `Error('injected: diagnostic waitlist count failed')` escapes `deleteTeacherAccount`. Record the exact failure text in the ledger. Restore the `.catch(() => -1)` and re-run to confirm GREEN again.

- [ ] **Step 8: Mutation 2 — prove the MOVE, not just the guard**

This is the mutation that matters: a `.catch()` on its own would pass Step 7 while leaving the reads where #242 found them. Temporarily move both reads and the `log.warn` back inside the `if (cancelled.count === 0)` branch, reading from `tx` instead of `db`, keeping both `.catch()`es — i.e. exactly the fix issue #242 asks for. Run the same command.

Expected: FAIL on `expect(teacherEmailWhenDiagnosticRan).toMatch(/@deleted\.invalid$/)`, because the diagnostic then runs before the erasure's `teacher.updateMany` and a separate connection reads the pre-erasure address. Record the exact failure text. Restore the post-commit version and re-run to confirm GREEN.

- [ ] **Step 9: Typecheck, lint, and the rest of the suite**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit --project unit-sweeps --project components`

Expected: all green. The `integration` project is skipped deliberately — it is hard-wired to the app on `:3000`, which in this worktree serves the main checkout's code, so CI is the signal for that tier.

- [ ] **Step 10: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts
git commit -m "$(cat <<'EOF'
fix(gdpr): read the CAS-skip diagnostic after the commit, not inside it

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARfLrK84YbeDUroiLQM2f5
EOF
)"
```

---

### Task 2: Record why a diagnostic inside an interactive transaction cannot be guarded

**Files:**
- Modify: `docs/lock-order.md` — new section inserted immediately after "## A CAS miss no re-read can classify answers `busy`, not a throw (issue 332)" (currently `:1431-1487`) and before "## Known conformance" (`:1487`)

**Interfaces:**
- Consumes: the heading string Task 1's comment links to, verbatim: **A diagnostic read inside an interactive transaction cannot be guarded (issue #242)**. Task 1 already writes that link; this task must create exactly that heading or the link dangles.
- Produces: nothing.

- [ ] **Step 1: Add the section**

Insert, between the two sections named above:

````markdown
## A diagnostic read inside an interactive transaction cannot be guarded (issue #242)

`.catch()` on a statement inside `db.$transaction(async (tx) => …)` does not
protect the transaction. Postgres aborts the whole transaction at the first
statement error, and Prisma issues no per-statement `SAVEPOINT`, so every
later statement raises `25P02 current transaction is aborted, commands ignored
until end of transaction block` until rollback. The guard swallows the cause
and the transaction dies anyway, one statement later, naming a failure nowhere
near the one that caused it.

Measured 2026-09-02 against `ethical_yoga_test` — a `SELECT 1/0` (`22012`)
caught with `.catch()`, followed by a valid read in the same transaction:

```
raw follow-up:   PrismaClientKnownRequestError P2010 — Raw query failed.
                 Code: `25P02`
model follow-up: PrismaClientUnknownRequestError — PostgresError
                 { code: "25P02", … }
control:         OK
```

`rule-lifecycle.test.ts`'s "swallows a failure from the shared delete" case
stages the same behaviour as a test fixture; re-derive it with:

```sh
git log -S'Every later statement raises' --oneline -- src/services/rule-lifecycle.test.ts
```

**Why the guard is worse than no guard.** `TRANSIENT_SQLSTATES` and
`TRANSIENT_PRISMA_CODES` (`src/lib/api-errors.ts`) list neither `25P02` nor
anything it arrives as, so `isTransientDbError` answers `false` for it while it
answers `true` for the `55P03` the guarded statement would have thrown.
`erasureFailure` (`src/app/api/account/route.ts`) reads that boolean: a
teacher whose erasure lost a lock race is told to wait a moment and press
Delete again (503 `ERASURE_BUSY`); with the guard in place the same teacher is
told that pressing Delete again will not help and to contact support (500
`ERASURE_FAILED`).

**So the fix for a diagnostic that must not fail its operation is placement,
not `.catch()`.** `deleteTeacherAccount` (`src/services/gdpr.ts`) collects the
class ids whose cancel CAS matched nothing, returns them from the transaction,
and reads their cause after the commit — where `db` is not `tx`, a failed read
costs only the field it fills, and `.catch()` means what it says. Returning the
list rather than capturing a mutable one is load-bearing: the value exists only
if the transaction committed. `deleteStudentAccount` in the same file has the
same shape for `freedClassIds`.

A `.catch()` on the whole `$transaction(…)` promise is a different thing and is
fine — `acceptInvitation` and `unlinkTeacher` (`src/services/invitations.ts`)
both do it. The rule is about a statement inside the callback. No site in
`src/` breaks it today; re-derive with:

```sh
grep -rn "\.catch(" src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

Every hit must be on `db`/`prisma`, on a `$transaction(…)` promise, or outside
the database entirely.
````

- [ ] **Step 2: Check the link Task 1 wrote resolves**

Run: `grep -n 'A diagnostic read inside an interactive transaction cannot be guarded' docs/lock-order.md src/services/gdpr.ts`

Expected: two hits — the heading in `docs/lock-order.md` and the citation in `src/services/gdpr.ts`, with identical wording.

- [ ] **Step 3: Verify the two re-derivation commands in the section actually run**

Run both `sh` blocks from the section as written. Expected: the `git log -S` command returns at least one commit; the `grep` returns the 16 non-test `.catch(` sites, none of them on a `tx.` receiver. If either command returns something other than what the prose claims, fix the prose — a shipped re-derivation command that is wrong is worse than no command.

- [ ] **Step 4: Commit**

```bash
git add docs/lock-order.md
git commit -m "$(cat <<'EOF'
docs(lock-order): why a diagnostic inside an interactive transaction cannot be guarded

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ARfLrK84YbeDUroiLQM2f5
EOF
)"
```

---

## Self-review notes

- **Coverage.** #242's stated goal ("a diagnostic must never be able to fail the operation it describes") is Task 1. Its stated *fix* is deliberately not implemented; the reason is in this plan's header, in Task 2's docs section, and belongs in the PR body.
- **Guards proven, not just present.** Step 7 proves the `.catch()`; Step 8 proves the placement. Step 8 exists because Step 7 alone passes against the harmful fix — the injected failure is client-side and never reaches Postgres, so it cannot poison a transaction and cannot tell the two designs apart on its own.
- **Not in scope.** `deleteStudentAccount` is unchanged: both of its diagnostic reads (`gdpr.ts:875`, `:989`) already run outside a transaction. No other `src/` site has a `.catch()` on a `tx.` statement.

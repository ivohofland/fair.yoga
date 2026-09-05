# Lock-order handshake diagnostics (issue #244) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `gdpr-lock-order.test.ts` name the lock-order regression it caught, instead of passing green (teacher side) or hanging for 30 s (student side).

**Architecture:** Both handshakes currently key on a bound value (`args.values[0] === teacherId`), which names a *set* of statements rather than a statement — and that set silently grew to three. Re-key both onto the pre-lock statement's own shape, then add three guards: a named timeout so a handshake that never fires says so in ~2 s, a firing-count assertion so a future sibling statement that widens the key fails loudly, and a positive lock-set assertion so a narrowed row set fails. Then correct the 13 stale comments a read-based audit found across six files.

**Tech Stack:** TypeScript strict, Prisma 6 client extensions (`$extends({ query: { $queryRaw } })`), Postgres row locks, Vitest (`unit-sweeps` project, `ethical_yoga_test` database).

**Spec:** `docs/superpowers/specs/2026-09-05-lock-handshake-diagnostics-design.md`

## Global Constraints

- TypeScript `strict: true`. No `any`, no implicit types. `args.sql` is typed `string` and `args.values` is typed — both verified against `npx tsc --noEmit` on 2026-09-05.
- **No production BEHAVIOUR changes.** `src/services/gdpr.ts` and `src/lib/db-locks.ts` are mutated only for measurement and must be restored byte-for-byte. Comment-only corrections in production files are in scope (Task 4 touches `src/services/waitlist.ts`).
- Every mutation is applied, measured, **restored**, and the restoration verified with `git diff --exit-code` before the task commits.
- Comments state what is true now. Never "this previously read X" — the before/after goes in the PR body (CLAUDE.md, *Comment Discipline*).
- A corrected sentence that would still assert a fact about another module is **deleted or narrowed to the local constraint**, not rewritten more accurately.
- Never `git add -A` or `git add .` — stage exact paths.
- Tests in this file run with: `npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts`

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/services/gdpr-lock-order.test.ts` | The two handshakes, the discriminator, the three guards | 1, 2 |
| `src/services/template-lock-order.test.ts` | 5 stale comments (2 self-contradictions) | 3 |
| `src/services/gdpr.test.ts` | 4 stale comments | 4 |
| `src/lib/db-locks.test.ts` | 1 stale comment | 4 |
| `tests/integration/account-api.test.ts` | 1 stale comment | 4 |
| `src/services/waitlist.ts` | 1 stale comment (production, comment-only) | 4 |
| `docs/lock-order.md` | 1 cross-reference addition (not a correction) | 4 |

No file is created. No production behaviour is modified.

## The mutation harness

Tasks 1 and 2 use the mutations below — A, B, C′, C″, D, E. Each is a python heredoc run from the repo root; each asserts its target text occurs exactly once, so a drifted file fails loudly instead of silently patching nothing. **Restore with the `git checkout` line after every measurement.**

````bash
# --- Mutation A: teacher Class pre-lock deleted -----------------------------
python3 - <<'PY'
p='src/services/gdpr.ts'; s=open(p).read()
old = """      const lockedIds = await lockClassRowsOrdered(tx, {
        join: Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`,
        where: Prisma.sql`e."teacherId" = ${teacherId}
          AND e."cancelledAt" IS NULL
          AND c.status IN (${CANCELLABLE_STATUSES_SQL})`,
        entries: true,
      });"""
new = """      const lockedIds = (
        await tx.class.findMany({
          where: {
            calendarEntry: { teacherId, cancelledAt: null },
            status: { in: CANCELLABLE_STATUSES },
          },
          select: { id: true },
        })
      ).map((c) => c.id);"""
assert s.count(old) == 1, s.count(old)
open(p,'w').write(s.replace(old,new)); print('A applied')
PY

# --- Mutation B: shared ORDER BY deleted (the #174 regression) --------------
python3 - <<'PY'
p='src/lib/db-locks.ts'; s=open(p).read()
old = """    WHERE ${source.where}
    ORDER BY c.id
    FOR UPDATE OF c"""
new = """    WHERE ${source.where}
    FOR UPDATE OF c"""
assert s.count(old) == 1, s.count(old)
open(p,'w').write(s.replace(old,new)); print('B applied')
PY

# --- Mutation C-prime: STUDENT pre-lock's row set narrowed to one class -----
# The STUDENT side, not the teacher side. Measured 2026-09-05: narrowing the
# TEACHER pre-lock already fails today, at `expect(cancelled).toBe(2)` — #367
# made that call a lock-then-read, so `lockedIds` is the scope of the cancel
# below it and the write set follows the lock set. The student call DISCARDS
# its return value and its `waitlistEntry.deleteMany` is unscoped by class, so
# narrowing it shrinks the lock set alone. That one passes green.
python3 - <<'PY'
p='src/services/gdpr.ts'; s=open(p).read()
old = """      where: Prisma.sql`w."studentId" = ${studentId}`,"""
new = """      where: Prisma.sql`w."studentId" = ${studentId}
        AND c.id = (SELECT min(c2.id) FROM "Class" c2
                    JOIN "WaitlistEntry" w2 ON w2."classId" = c2.id
                    WHERE w2."studentId" = ${studentId})`,"""
assert s.count(old) == 1, s.count(old)
open(p,'w').write(s.replace(old,new)); print("C-prime applied")
PY

# --- Mutation C-double-prime: TEACHER pre-lock narrowed to one class --------
# Fails TODAY, but at `cancelled` — an assertion about cancellation that says
# nothing about locking, and that only covers this by way of #367's
# lock-then-read. After Task 2 it must fail at the lock-set assertion instead:
# coverage that is stated rather than incidental.
python3 - <<'PY'
p='src/services/gdpr.ts'; s=open(p).read()
old = """        where: Prisma.sql`e."teacherId" = ${teacherId}
          AND e."cancelledAt" IS NULL
          AND c.status IN (${CANCELLABLE_STATUSES_SQL})`,"""
new = """        where: Prisma.sql`e."teacherId" = ${teacherId}
          AND e."cancelledAt" IS NULL
          AND c.status IN (${CANCELLABLE_STATUSES_SQL})
          AND c.id = (SELECT min(c2.id) FROM "Class" c2
                      JOIN "CalendarEntry" e2 ON e2.id = c2."calendarEntryId"
                      WHERE e2."teacherId" = ${teacherId})`,"""
assert s.count(old) == 1, s.count(old)
open(p,'w').write(s.replace(old,new)); print("C-double-prime applied")
PY

# --- Mutation D: student Class pre-lock deleted -----------------------------
python3 - <<'PY'
p='src/services/gdpr.ts'; s=open(p).read()
old = """    await lockClassRowsOrdered(tx, {
      join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
      where: Prisma.sql`w."studentId" = ${studentId}`,
    });"""
assert s.count(old) == 1, s.count(old)
open(p,'w').write(s.replace(old,'')); print('D applied')
PY

# --- Mutation E: a SECOND statement matching the discriminator --------------
# Proves the firing-count guard. Reserved-shape statement that locks nothing
# real: `WHERE false` matches no row, so it cannot poison live state.
python3 - <<'PY'
p='src/services/gdpr.ts'; s=open(p).read()
old = """      const lockedIds = await lockClassRowsOrdered(tx, {"""
new = """      await tx.$queryRaw`SELECT c.id FROM "Class" c WHERE false FOR UPDATE OF c`;
      const lockedIds = await lockClassRowsOrdered(tx, {"""
assert s.count(old) == 1, s.count(old)
open(p,'w').write(s.replace(old,new)); print('E applied')
PY

# --- RESTORE (run after every measurement) ---------------------------------
git checkout -- src/services/gdpr.ts src/lib/db-locks.ts && git diff --exit-code && echo RESTORED
````

**Baseline, measured 2026-09-05 against `ethical_yoga_test` on `ed0768c7`:** unmutated, the file passes in 1.15 s of test time.

---

### Task 1: Re-key both handshakes onto the statement's shape, and name the timeout

Fixes mutations **A** (teacher pre-lock deleted → currently passes green) and **D** (student pre-lock deleted → currently hangs 30 s).

**Files:**
- Modify: `src/services/gdpr-lock-order.test.ts` — the two `$queryRaw` hooks (~`:300-315` and `:353-362`), the two awaits (~`:404`, `:423`), and the module-scope area above `describe`.

**Interfaces:**
- Produces: `isClassPreLock(sql: string): boolean` and `awaitHandshake(signal: Promise<void>, label: string): Promise<void>`, both module-scope in this file. Task 2 consumes `isClassPreLock`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Reproduce the defect — mutation A must currently pass green**

Apply mutation A, then run:

```bash
npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts 2>&1 | tail -8
```

Expected: `Tests 1 passed (1)` in ~1 s. **That green pass is the bug.** Record the exact output. Restore.

- [ ] **Step 2: Reproduce the second defect — mutation D must currently hang**

Apply mutation D, run the same command. Expected: `Test timed out in 30000ms.` after ~30 s, naming no statement. Record the exact output. Restore, and verify with `git diff --exit-code`.

- [ ] **Step 3: Add the discriminator and the timeout helper**

Insert at module scope in `src/services/gdpr-lock-order.test.ts`, after the imports and before the first `/**` docblock:

```ts
/**
 * The `Class` pre-lock, identified by the statement's own shape.
 *
 * NOT by a bound value. `values[0] === teacherId` names a SET of statements —
 * every one whose first bind is that id — and this file keyed on exactly that
 * until the set grew underneath it. Measured 2026-09-05: three of
 * `deleteTeacherAccount`'s statements bind `teacherId` first, so the handshake
 * fired on #229's `ClassTemplate` pre-lock and deleting the `Class` pre-lock
 * passed green.
 *
 * `lockClassRowsOrdered`'s statement is the only one carrying BOTH fragments,
 * and each excludes a different sibling: the template pre-locks are
 * `FROM "ClassTemplate" ct` (which does contain `FOR UPDATE OF c`, as a prefix
 * of `OF ct`), and the entries lock is `JOIN "Class" c … FOR UPDATE OF e`.
 * That reasoning is argued here and ASSERTED by the firing counts below — a
 * future statement that matches drives one past 1 and fails by name.
 */
const isClassPreLock = (sql: string): boolean =>
  sql.includes('FROM "Class" c') && sql.includes('FOR UPDATE OF c');

/**
 * How long a handshake may wait before the test says which one never fired.
 *
 * Measured 2026-09-05 against `ethical_yoga_test`: the `Class` pre-lock is
 * issued 5-13ms after the erasure call (13ms cold, 5-6ms warm, over five
 * runs), so this is ~150x the cold worst case. Its whole job is to replace a
 * 30_000ms vitest timeout that names nothing.
 */
const HANDSHAKE_TIMEOUT_MS = 2_000;

/**
 * Await a handshake, or fail naming the statement that never came.
 *
 * The bare `await` this replaces could not fail: a handshake that never fires
 * leaves the test hanging until vitest kills it at 30s, and the message it
 * dies with names the `it`, not the missing statement.
 */
async function awaitHandshake(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never issued within ${HANDSHAKE_TIMEOUT_MS}ms`)),
          HANDSHAKE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Re-key the teacher hook**

Replace the teacher hook's `$queryRaw` body — the block currently reading `if (args.values[0] === teacherId) { preLockReached(); }` together with the comment above it (the comment beginning "Keyed on the query's own bound value") — with:

```ts
        async $queryRaw({ args, query }) {
          // Keyed on the statement's shape, not on its binds — see
          // `isClassPreLock` above for the measurement that forced that.
          if (isClassPreLock(args.sql)) {
            teacherPreLockFirings += 1;
            preLockReached();
          }
          return query(args);
        },
```

Declare the counter beside `preLockReached`:

```ts
    let teacherPreLockFirings = 0;
    let preLockReached!: () => void;
```

- [ ] **Step 5: Re-key the student hook**

Replace the student hook's `if (args.values[0] === studentId) { studentPreLockReached(); }` and the comment above it (beginning "Same key as the teacher's hook") with:

```ts
        async $queryRaw({ args, query }) {
          // Same discriminator as the teacher's hook. This side keyed on
          // `studentId` and fired correctly, but only because
          // `deleteStudentAccount` happens to have exactly one statement
          // binding it — a property of today's call graph, not a guarantee,
          // and one sibling statement away from the teacher side's failure.
          if (isClassPreLock(args.sql)) {
            studentPreLockFirings += 1;
            studentPreLockReached();
          }
          return query(args);
        },
```

Declare the counter beside `studentPreLockReached`:

```ts
    let studentPreLockFirings = 0;
    let studentPreLockReached!: () => void;
```

- [ ] **Step 6: Guard both awaits**

Replace `await preLockReachedPromise;` with:

```ts
    await awaitHandshake(preLockReachedPromise, 'teacher Class pre-lock');
```

Replace `await studentPreLockReachedPromise;` with:

```ts
    await awaitHandshake(studentPreLockReachedPromise, 'student Class pre-lock');
```

- [ ] **Step 7: The 200 ms sleep's comment is now true — say so accurately**

The comment above the 200 ms sleep reads "Time for the teacher's pre-lock to reach and block on its first row." Until this task it was budgeted from the *template* lock. Leave the sentence (it is now true) and add nothing about what it used to be — that belongs in the PR body.

- [ ] **Step 8: Verify the test still passes, and still reproduces the race**

```bash
npx tsc --noEmit
npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts 2>&1 | tail -8
```

Expected: typecheck clean; `Tests 1 passed (1)`, test-body time under 2 s.

**Then the load-bearing check.** Re-keying makes both handshakes fire *later* than before, which could stop the choreography reproducing the AB-BA race at all. Apply **mutation B** and run again.

Expected: `Tests 1 failed (1)` with `40P01` / `deadlock detected` in the output, in ~2 s. **If mutation B now passes, the re-key has destroyed the test's subject** — stop and report it rather than proceeding; the fix would then need the sleeps retuned, not just the key changed. Restore.

- [ ] **Step 9: Prove the timeout bites — mutation A**

Apply mutation A, run the test. Expected: `Tests 1 failed (1)` in ~2 s with

```
Error: teacher Class pre-lock never issued within 2000ms
```

Record the exact text. Restore.

- [ ] **Step 10: Prove the timeout bites — mutation D**

Apply mutation D, run the test. Expected: failure in ~2 s with

```
Error: student Class pre-lock never issued within 2000ms
```

Record the exact text. Restore, and verify:

```bash
git checkout -- src/services/gdpr.ts src/lib/db-locks.ts && git diff --exit-code src/services/gdpr.ts src/lib/db-locks.ts && echo RESTORED
```

- [ ] **Step 11: Commit**

```bash
git add src/services/gdpr-lock-order.test.ts
git commit -m "test(lock-order): the handshake names its statement, not a bound value (#244)"
```

---

### Task 2: Assert the handshake fired once, and on the rows it claimed

Fixes mutation **C′** (the *student* pre-lock's row set narrowed → currently passes green) and mutation **E** (a second matching statement silently widening the key → currently invisible). Also converts **C″** (the *teacher* pre-lock narrowed) from an incidental failure into a stated one.

**The two sides are not symmetric, and the measurement is why this task exists in this shape.** Narrowing the teacher's pre-lock already fails today — at `expect(cancelled).toBe(2)` — because #367 made that call a lock-then-read, so `lockedIds` scopes the cancel below it and the write set follows the lock set. Narrowing the *student's* passes green: that call discards its return value, and the `waitlistEntry.deleteMany` below it is unscoped by class, so the lock set drops from two rows to one while the write set is untouched. `docs/lock-order.md:53-58` already records that erasure's lock set as "strictly smaller than its `WaitlistEntry` write set"; narrowing it widens a gap the project tracks, silently.

**Files:**
- Modify: `src/services/gdpr-lock-order.test.ts` — both hooks, and the assertion block after `Promise.all([teacherErasure, studentErasure])`.

**Interfaces:**
- Consumes: `isClassPreLock` from Task 1, and the `teacherPreLockFirings` / `studentPreLockFirings` counters Task 1 introduced.
- Produces: nothing later tasks depend on.

**Task order is load-bearing:** Task 1 must land first — this task's assertions read the counter and the discriminator it introduces.

- [ ] **Step 1: Reproduce the defect — mutation C′ must currently pass green**

Apply mutation C′ (narrows the **student's** pre-lock to a single class while keeping the statement), run:

```bash
npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts 2>&1 | tail -8
```

Expected: `Tests 1 passed (1)` in ~1 s. This is the issue's own predicted blind spot, confirmed — on the side the issue does not name. Record the output. Restore.

- [ ] **Step 1b: Record the asymmetry — mutation C″ fails, but for the wrong reason**

Apply mutation C″ (narrows the **teacher's** pre-lock), run the same command.

Expected: `Tests 1 failed (1)` with `AssertionError: expected 1 to be 2` at `expect(cancelled).toBe(2)` (`:466`). Record the exact text: this is coverage by accident, from an assertion about cancellation. Step 5 below requires it to fail at the lock-set assertion instead. Restore.

- [ ] **Step 2: Capture what each pre-lock actually locked**

In the teacher hook, replace the body written in Task 1 Step 4 with:

```ts
        async $queryRaw({ args, query }) {
          // Keyed on the statement's shape, not on its binds — see
          // `isClassPreLock` above for the measurement that forced that.
          if (isClassPreLock(args.sql)) {
            teacherPreLockFirings += 1;
            preLockReached();
            const rows = await query(args);
            teacherLockedIds = (rows as Array<{ id: string }>).map((row) => row.id);
            return rows;
          }
          return query(args);
        },
```

Declare beside the counter:

```ts
    let teacherLockedIds: string[] = [];
```

Apply the mirror change to the student hook, with `studentPreLockFirings` and:

```ts
    let studentLockedIds: string[] = [];
```

- [ ] **Step 3: Assert the counts and the lock sets**

Insert immediately **after** the `for (const [label, outcome] of …)` SQLSTATE loop and **before** `expect(teacherOutcome).toBe('teacher-ok');`:

```ts
    // EXACTLY ONE firing each, and this is the assertion the rest of the file
    // rests on. `isClassPreLock` argues that no sibling statement matches it;
    // this is that argument checked, every run. A statement added to either
    // erasure that happens to match drives its count to 2 and fails here —
    // which is what the bound-value key could not do, and why deleting the
    // teacher's pre-lock used to pass green.
    expect({ teacher: teacherPreLockFirings, student: studentPreLockFirings }).toEqual({
      teacher: 1,
      student: 1,
    });

    // And each pre-lock asked for BOTH rows, ascending. A statement that still
    // runs but locks a narrower set satisfies every other assertion in this
    // file — the erasures still succeed, both classes still end cancelled, the
    // entries still go — so this is the only thing standing between a narrowed
    // `WHERE` and a green run.
    expect({ teacher: teacherLockedIds, student: studentLockedIds }).toEqual({
      teacher: [LOW_CLASS_ID, HIGH_CLASS_ID],
      student: [LOW_CLASS_ID, HIGH_CLASS_ID],
    });
```

- [ ] **Step 4: Verify the test still passes**

```bash
npx tsc --noEmit
npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts 2>&1 | tail -8
```

Expected: typecheck clean, `Tests 1 passed (1)`, test-body time under 2 s.

- [ ] **Step 5: Prove the lock-set assertion bites — mutations C′ and C″**

Apply mutation **C′** (student side), run. Expected: `Tests 1 failed (1)` at the lock-set assertion, with the `student` key holding one id where two were expected. This is the case that had **no** coverage before this task. Record the exact text. Restore.

Then apply mutation **C″** (teacher side), run. Expected: failure at the **lock-set assertion**, naming the `teacher` key — *not* at `expect(cancelled).toBe(2)`.

The lock-set assertion sits before the outcome assertions precisely so it wins this race; if C″ still reports `expected 1 to be 2` at `cancelled`, the new assertion is in the wrong place in the test body. Move it above the outcome assertions rather than accepting the weaker message. Record the exact text. Restore.

- [ ] **Step 6: Prove the firing-count assertion bites — mutation E**

Apply mutation E (adds a second `FROM "Class" c … FOR UPDATE OF c` statement to `deleteTeacherAccount`), run. Expected: failure naming `teacher: 2` against `teacher: 1`.

This is the mutation that reproduces `ba0dbb8a`'s actual failure — a sibling statement joining the set the handshake keys on. Record the exact text. Restore, and verify:

```bash
git checkout -- src/services/gdpr.ts src/lib/db-locks.ts && git diff --exit-code src/services/gdpr.ts src/lib/db-locks.ts && echo RESTORED
```

- [ ] **Step 7: Confirm mutation B is still detected**

Apply mutation B, run, expect the `40P01` failure unchanged. Restore and verify. This guards against the new assertions accidentally short-circuiting the SQLSTATE checks.

- [ ] **Step 8: Commit**

```bash
git add src/services/gdpr-lock-order.test.ts
git commit -m "test(lock-order): the pre-lock fired once, and on the rows it claimed (#244)"
```

---

### Task 3: `template-lock-order.test.ts`'s five stale comments

This file states the correct mechanism **twice** and the wrong one **five times**. Two of the five are the self-contradictions the audit isolated.

**Files:**
- Modify: `src/services/template-lock-order.test.ts` at `:252-253`, `:375-377`, `:378-388`, `:610-614`, `:629-631`.

**Interfaces:** none — prose only. No assertion, fixture or hook changes.

**This task does NOT decide what those two `it`s are for.** That question (delete / re-aim / restore) is filed separately in Task 5. Correcting a comment to describe the hook's *actual* mechanism is neutral to that decision.

- [ ] **Step 1: Confirm the file is green before touching it**

```bash
npx vitest run --project unit-sweeps src/services/template-lock-order.test.ts 2>&1 | tail -6
```

Record the pass count and duration; the same command must give the same result at the end.

- [ ] **Step 2: Correct `:252-253`**

Currently: "…`archiveOrUnarchiveTemplate`'s `deleteMany` visits [HIGH, LOW] while `deleteStudentAccount`'s sorted lock loop visits [LOW, HIGH]."

Must say instead: `deleteStudentAccount` requests both rows in **one** statement ordered `ORDER BY c.id`, so it asks for [LOW, HIGH] in a single acquisition — no JS sort, no loop. Keep the rest of the sentence (the [HIGH, LOW] half is correct).

- [ ] **Step 3: Correct `:375-377`**

Currently: "The hook lives on `deleteStudentAccount`'s `lockClassRow` loop instead — the same `erasureDb` shape, keyed on the LOW class id, signalling once LOW is locked and holding 300ms before reaching for HIGH."

Falsified by this same file at `:479-486`, and by the hook body at `:517` (`if (args.values[0] === studentId)`). Must say instead: the hook keys on `studentId` and fires on the single `lockClassRowsOrdered` statement — **before** it runs, not between two per-class locks — then holds 300 ms.

- [ ] **Step 4: Correct `:378-388`**

Currently describes the pre-#237 interleaving: the erasure locks LOW, signals, holds; the archive's pre-lock arrives, finds LOW held, and WAITS.

Contradicted by `:488-493` and `:685-690` in this same file, which state the interleaving **inverts**. Must say instead: the erasure signals before it takes any row, so `archiveOrUnarchiveTemplate` takes its ordered pre-lock first and the erasure blocks behind it — the archive is the holder here, not the waiter.

**Check for duplication before writing.** `:488-493` already states this correctly and at length. Prefer pointing at that passage over restating it; a second copy is a second thing to keep true.

- [ ] **Step 5: Correct `:610-614`**

Currently: "both `it`s above are the same shape (each hooks `deleteStudentAccount`'s `lockClassRow` loop to land a write mid-transaction)".

Two errors. Must say instead: both `it`s hook `deleteStudentAccount`'s single ordered `lockClassRowsOrdered` statement, keyed on `studentId` — and one of the two is the `it` **below** this docblock, not above it.

- [ ] **Step 6: Correct `:629-631`**

Currently: "…reaches for a row a narrow pre-lock never held — out of order, against the erasure's ascending loop."

Must say instead: out of order, against the erasure's single ascending `ORDER BY c.id` acquisition.

- [ ] **Step 7: Re-read the whole file for survivors**

A grep finds a stale name, never a stale description. Read every docblock in the file — not only the five above — and confirm no remaining passage asserts a per-class loop, a JS sort, or the pre-#237 interleaving. The audit's census is the starting point, not the boundary; the reason this list exists is that the claim keeps changing verb.

Record any additional location found, with its verdict, for the PR body.

- [ ] **Step 8: Verify green and commit**

```bash
npx vitest run --project unit-sweeps src/services/template-lock-order.test.ts 2>&1 | tail -6
git add src/services/template-lock-order.test.ts
git commit -m "docs(lock-order): the file's four wrong copies of its own mechanism (#244)"
```

Expected: identical pass count and comparable duration to Step 1.

---

### Task 4: The remaining seven stale comments, and the missing rebuttal pointer

**Files:**
- Modify: `src/services/gdpr.test.ts` at `:30-32`, `:563-566`, `:584-586`, `:800-806`
- Modify: `src/lib/db-locks.test.ts` at `:116-118`
- Modify: `tests/integration/account-api.test.ts` at `:564-570`
- Modify: `src/services/waitlist.ts` at `:1021-1024` (production file, comment only)
- Modify: `docs/lock-order.md` at `:1653-1668` (an addition, not a correction)

**Interfaces:** none — prose only.

- [ ] **Step 1: `gdpr.test.ts:30-32`**

Currently: "an erasure with an empty lock set, where the lock loop never runs."

Must say instead: there is no loop — the ordered pre-lock statement runs unconditionally and simply matches zero rows, which is why the `setLockTimeout` hoist above it is what supplies the bound.

- [ ] **Step 2: `gdpr.test.ts:563-566`**

Currently: "The 2s bound used to arrive only as a side effect of `lockClassRow`, which runs once per class the erased student is `waiting` in…"

The framing verb is past but the relative clause is present tense, and it is also wrong about the old loop's own scope. Must say instead: the bound *arrived* from a `lockClassRow` loop that *ran* once per class the student held an entry in — `waiting`-only in #174, every status by #216/#182 — and today arrives unconditionally from `setLockTimeout` at the top of the transaction.

- [ ] **Step 3: `gdpr.test.ts:584-586`**

Currently: "With a `waiting` entry here the lock loop would run, `lockClassRow` would set the bound, and this test would pass without the hoist it exists to pin."

Must say instead: with an entry of **any** status here the ordered `lockClassRowsOrdered` statement would lock a row and its internal `setLockTimeout` would set the bound, so this test would pass without the unconditional hoist it exists to pin.

- [ ] **Step 4: `gdpr.test.ts:800-806`**

The most substantive of the seven: it is the stated justification for the `status: 'waiting'` premise assertion directly below it, so the premise is currently defended by a false reason.

Currently: "…it only takes one when its own `waitlistEntry.findMany({ where: { studentId, status: 'waiting' } })` returns something. Drift the fixture's status, or narrow that filter, and the lock loop stops running…"

Both halves are false. The pre-lock (`gdpr.ts:433`) runs **before** that `findMany` (`gdpr.ts:449`) and joins `WaitlistEntry` with **no status predicate**; the `waiting`-scoped `findMany` only feeds the reorder. Must say instead: `deleteStudentAccount` takes a `Class` lock whenever the student holds a `WaitlistEntry` of any status, via the ordered pre-lock that runs before any read — so drifting the fixture's status leaves the lock in place, and this canary needs a different reason for its premise assertion than the one it gives.

**If the corrected reasoning no longer justifies the `status: 'waiting'` assertion below it**, say so plainly in the comment rather than inventing a justification, and record it for the PR body. Do not delete the assertion.

- [ ] **Step 5: `db-locks.test.ts:116-118`**

Currently: "Called twice in one transaction — `deleteStudentAccount` (`gdpr.ts`) does exactly this, once up front and again inside `lockClassRow` per class it locks."

This is a test for `db-locks.ts` asserting `gdpr.ts`'s call shape — a cross-file claim, and the clearest instance of why the rule exists. **Narrow it to the local constraint** rather than rewriting it accurately: the docblock's job is to say that `setLockTimeout` called twice in one transaction overwrites rather than stacks, which is a fact about this module. Drop the `gdpr.ts` sentence, or reduce it to a bare "at least one caller does this" with no mechanism.

- [ ] **Step 6: `account-api.test.ts:564-570`**

Currently: "…this test holds the `Class` row that `deleteStudentAccount`'s own `lockClassRow` loop must take (the student is `waiting` in that class), for longer than the 2s `SET LOCAL lock_timeout` that loop sets."

Two present-tense assertions of a removed mechanism, and both reach into `gdpr.ts` from a route test. Must say instead, and as locally as possible: the test holds the `Class` row the erasure's ordered pre-lock takes, for longer than the 2 s bound, so Postgres cancels the erasure with `55P03` and the route has to read it as contention. Name no helper this file does not use.

- [ ] **Step 7: `waitlist.ts:1021-1024`** *(production file, comment only)*

Currently: "`deleteTeacherAccount`'s cancel loop (`gdpr.ts`, near its `class.updateMany` CAS, to `removed`)…"

A different drift axis from the rest: the CAS has been `tx.calendarEntry.updateMany` since **#327** (`gdpr.ts:1203`) and takes a `CalendarEntry` lock, not a `Class` one. The sentence's second half — that the conflicting `Class` lock comes from the pre-lock — is correct and is what makes the first half's error non-load-bearing. Correct the CAS name; keep the second half.

- [ ] **Step 8: `docs/lock-order.md:1653-1668` — add the missing pointer**

**This is an addition, not a correction.** The passage's mechanism is right and its tense is past; the audit confirmed it. What it lacks is what issue #244's acceptance asks for: it reproduces the "monotone all-status count → past the ceiling → an account that could never be erased" reasoning that PR #246 falsified, with no pointer to the rebuttal.

Add a cross-reference to `src/services/gdpr.ts`'s transaction-budget comment (currently `:728-745`), stating that the count half of that argument is rebutted there: `min(5_000 + N × 2_000, 20_000)` is monotone non-decreasing in N and capped, so an all-status count could only ever grant *more* budget, never less. Cite by name and issue, not by line number — line numbers in another file rot.

- [ ] **Step 9: Sweep for what was invalidated**

The corrections remove several present-tense mentions of `lockClassRow` attached to the erasures. Re-derive:

```bash
grep -rn "deleteStudentAccount\|deleteTeacherAccount" --include='*.ts' --include='*.md' src/ tests/ docs/ \
  | grep -v "docs/superpowers" \
  | grep -iE "loop|sorted|per class|per-class|round trip|iteration"
```

Every hit gets a verdict. Expect legitimate survivors: `lockClassRow` is a live single-row helper with real callers, `deleteStudentAccount` retains a genuine **post-commit** loop (`gdpr.ts:873`) unrelated to locking, and several passages are correctly past-tense. Record the survivors and why, for the PR body.

- [ ] **Step 10: Verify and commit**

```bash
npx vitest run --project unit-sweeps src/services/gdpr.test.ts src/lib/db-locks.test.ts 2>&1 | tail -6
npx vitest run --project unit src/lib/db-locks.test.ts 2>&1 | tail -6
npx tsc --noEmit && npm run lint
git add src/services/gdpr.test.ts src/lib/db-locks.test.ts tests/integration/account-api.test.ts src/services/waitlist.ts docs/lock-order.md
git commit -m "docs(lock-order): seven claims the loop's removal retired, and the rebuttal's pointer (#244)"
```

Note `db-locks.test.ts` is in the `unit` project, not `unit-sweeps` — run whichever the file belongs to; if unsure, `npx vitest run src/lib/db-locks.test.ts` selects across projects.

---

### Task 5: File the two spun-out decisions

**Files:** none in this repo. Two GitHub artifacts.

- [ ] **Step 1: File thread C as its own issue**

Title along the lines of: *"`template-lock-order.test.ts`'s two deadlock `it`s detect neither mutation aimed at them — decide what they are for"*.

Body must carry, from issue #244's second comment (2026-09-04) and this branch's measurements:

- The measured detection table: `ORDER BY c.id` deleted → **0/12** here, 12/12 in `db-locks-lock-order.test.ts`; pre-lock status list narrowed → **0/3** here, uncovered elsewhere.
- The three options, as a decision rather than as work: **delete** them (their stated target is covered 12/12 by the sibling; cost: the fixture and its `premiseOrder` probes go too), **re-aim** them at what they can still detect (`archiveOrUnarchiveTemplate`'s real transaction end-to-end, `deleted: 2 / remaining: 0` — real coverage, but not "does not deadlock", so names and docblocks must change), or **restore** their detection power by giving the two callers an application-level window to interleave again (most work; re-introduces the choreography fragility #244 is about).
- That **#289 is unaffected** (the pre-lock-superset property over a non-UTC session `TimeZone` is a different missing test in the same pre-lock) and **#245 is unaffected** (`lockClassRowsOrdered`'s docblock contract is a different subject).
- That this branch corrected that file's stale *comments* (Task 3) and deliberately did not touch its `it`s.

Post via `--body-file`, never `--body "…"` — backticks in a double-quoted shell string reach zsh as command substitution and fail silently. Never write the string "does not close #N": GitHub's auto-close parser matches the keyword regardless of negation or quoting. Write "**#N is unaffected**".

- [ ] **Step 2: Comment the two prose rosters onto #245**

`gdpr.ts:479-489` carries a four-member roster of `lockClassRowsOrdered` call sites and `gdpr.ts:1042-1053` a five-member one. CLAUDE.md forbids both outright ("Never write a count or a member list in prose — name the type"), and `db-locks.ts:381-389` explicitly refuses to keep such a roster.

The comment must record that both are **accurate today**, that `gdpr.ts:479-489` is a near-verbatim duplicate of the already-**owned** census at `docs/lock-order.md:76-84` — same membership, same "Five until #194", same `grep -rn 'lockClassRowsOrdered(' src/` re-derivation — so its fix is a one-line pointer rather than a rewrite, and that #244 declined to fold it in because it would expand a test-diagnostics PR into production files it otherwise only reads.

Post via `--body-file`.

- [ ] **Step 3: Verify both landed**

```bash
gh issue view <new-issue-number> --json number,title,state
gh issue view 245 --json comments -q '.comments[-1].body' | head -20
```

---

## Self-Review

**Spec coverage.** §2.1 discriminator → Task 1 Step 3. §2.2 named timeout → Task 1 Steps 3, 6, 9, 10; firing count → Task 2 Steps 3, 6; lock set → Task 2 Steps 2, 3, 5. §2.3 both handshakes → Task 1 Steps 4-5, Task 2 Step 2. §3 mutation harness → the harness block (five mutations, A/B/C′/C″/D/E), exercised by Task 1 Steps 1-2, 8-10 and Task 2 Steps 1, 1b, 5-7. §4 census → Tasks 3 and 4, thirteen locations plus the `docs/lock-order.md` addition. §5 non-goals → Task 5 files thread C and the rosters; the global constraint pins `gdpr.ts`/`db-locks.ts` to byte-identical.

**Placeholder scan.** Every code step carries real code. The prose-correction steps in Tasks 3 and 4 state the corrected *fact* and deliberately do not dictate wording — the surrounding docblocks vary in voice, and CLAUDE.md's rule is that the comment says what is true now, not that it says a particular sentence.

**Type consistency.** `isClassPreLock(sql: string): boolean` is defined in Task 1 Step 3 and consumed under that exact name in Task 1 Steps 4-5 and Task 2 Step 2. `awaitHandshake(signal, label)` is defined in Task 1 Step 3 and called in Step 6. `teacherPreLockFirings` / `studentPreLockFirings` are declared in Task 1 Steps 4-5 and read in Task 2 Step 3. `teacherLockedIds` / `studentLockedIds` are declared and assigned in Task 2 Step 2 and read in Step 3. `LOW_CLASS_ID` / `HIGH_CLASS_ID` already exist in the file's `describe` scope.

**A spec claim this plan corrects.** The spec's first draft asserted that narrowing *either* pre-lock's row set passes green. Measured while writing this plan, only the STUDENT side does; the teacher side already fails at `expect(cancelled).toBe(2)`, because #367's lock-then-read makes its write set follow its lock set. Mutation C′ is therefore the student narrowing and C″ the teacher one, and Task 2 Step 5 requires C″ to move from an incidental failure to a stated one. The spec has been corrected to match.

**One risk carried explicitly.** Task 1 Step 8 checks that mutation B still fails after the re-key. Re-keying moves both signals later, and if that stops the choreography constructing the AB-BA cycle, the test's whole subject is gone — a regression this plan would otherwise ship green. The step says to stop and report rather than proceed.

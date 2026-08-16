# Flat erasure transaction budget (#240) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `deleteStudentAccount`'s `timeout: Math.min(5_000 + waitingCount * 2_000, 20_000)` with a flat `timeout: 20_000`, delete the pre-transaction count that fed it, and correct the six live artifacts that assert the removed claim.

**Architecture:** One behaviour change (a constant), one deletion (a query and ~40 lines of comment defending it), one comment rewrite that must preserve four measurements nothing else records, and a five-file documentation sweep. A single new test reproduces the defect before the fix and proves it gone after.

**Tech Stack:** TypeScript strict, Prisma + PostgreSQL, Vitest (three projects: `unit`, `components`, `integration`).

**Spec:** `docs/superpowers/specs/2026-08-16-erasure-budget-design.md` — read §1.3 (the inverted argument) and §3 (the test's three traps) before starting.

## Global Constraints

- **Do not start or restart the dev server on `:3000`.** The user runs it; the `integration` project needs it live.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **`@/lib/log` is pino and server-only.** No task here adds an import, but do not introduce one.
- **Commit per task.** The PR is rebase-merged, so the per-task history is the record.
- **#243 is not part of this branch.** It is closed unbuilt (spec §1.4). Do not scope the `waitlistEntry.deleteMany`, do not capture `lockClassRowsOrdered`'s return in `gdpr.ts`, do not edit `db-locks.ts:286-291`.
- **Verify every line number before editing at it.** All references below were checked on 2026-08-16 and held, but one of the spec's own freshly-written references was wrong (§1.1). Re-run `sed -n '<n>p' <file>` and fix a drifted reference in place, reporting it.
- **Baseline, measured 2026-08-16:** `54 + 38 + 28 = 120` files, `775 + 207 + 410 = 1392` tests, green. Predicted after: 121 files is wrong — the new test goes in an existing file, so **120 files, 1393 tests**. Measure it anyway; a prediction is not a result.

---

## File Structure

| File | Change |
|---|---|
| `src/services/gdpr.test.ts` | **Modify** — add one fixture, one cleanup helper, one test (Task 1) |
| `src/services/gdpr.ts` | **Modify** — delete `:279-318`, rewrite `:631-736`, fix the cross-reference at `:387-388` (Task 2) |
| `src/lib/db-locks.ts` | **Modify** — `:161-165` (Task 3) |
| `src/lib/api-errors.ts` | **Modify** — `:122` (Task 3) |
| `src/app/api/account/route.ts` | **Modify** — `:27-28` (Task 3) |
| `src/app/api/class-templates/route.ts` | **Modify** — `:121-122` (Task 3) |
| `docs/lock-order.md` | **Modify** — `:700-710`, `:910` (Task 3) |

**Task order is load-bearing.** Task 1 must land before Task 2, because the test failing with `P2028` against the *unfixed* code is the reproduction of #240. Run it after Task 2 and you have a passing test that never demonstrated anything.

---

## Task 1: Reproduce the defect

A student with **zero** `waiting` entries gets `Math.min(5_000 + 0, 20_000)` = 5_000ms. Six class rows held with staggered releases make the ordered pre-lock spend ≈8.7s in total while no single lock wait reaches the 2s `lock_timeout`. The next statement after it is then refused with `P2028`.

**Files:**
- Modify: `src/services/gdpr.test.ts` (append the fixture and cleanup helper after `cleanupStudentWaitingInClass`, which ends at `:147`; add the test inside the existing `describe('GDPR (DB)', ...)` block that opens at `:149`)

**Interfaces:**
- Consumes: `prisma` (`gdpr.test.ts:14`), `PrismaClient` (`:2`), `crypto` (`:4`), `deleteStudentAccount` (`:8`)
- Produces: `makeStudentWithClosedEntriesInClasses(classCount: number)` returning `{ studentId: string; classIds: string[]; teacherId: string; roomId: string; accountId: string }` with `classIds` **sorted ascending**; and `cleanupStudentWithClosedEntries(fixture)` returning `Promise<void>`. Nothing later in this plan consumes them. (`Teacher.accountId` is `String @unique` — non-nullable, `schema.prisma:127`. It is `Student.accountId` at `:165` that is `String?`.)

- [ ] **Step 1: Confirm the anchor lines before editing**

```bash
sed -n '147p;149p' src/services/gdpr.test.ts
```

Expected: `147` is the closing `}` of `cleanupStudentWaitingInClass`; `149` is `describe('GDPR (DB)', () => {`. If either has moved, locate them with `grep -n "cleanupStudentWaitingInClass\|describe('GDPR (DB)'" src/services/gdpr.test.ts` and report the drift.

- [ ] **Step 2: Add the fixture and its cleanup, immediately after line 147**

```ts
/**
 * A student with a CLOSED waitlist entry in each of `classCount` classes, and
 * none `waiting`. The shape the old sized budget was worst at.
 *
 * `waitingCount` counted `waiting` entries only, so this student scored zero
 * and got the 5_000ms floor — against a pre-lock whose join carries no status
 * predicate and therefore asks for `classCount` row locks. That mismatch is
 * #240's first axis, and this fixture is the only thing in the suite that can
 * express it: `makeStudentWaitingInClass` builds exactly one class.
 *
 * `status: 'open'` on the classes and `'expired'` on the entries, matching
 * `makeStudentWaitingInClass({ entryStatus: 'expired' })` rather than being
 * more realistic than it. A closed entry in production sits on a class that
 * has started, but nothing in this erasure reads class status for the
 * pre-lock, and consistency with the fixture already in this file is worth
 * more than the realism.
 *
 * `classIds` comes back SORTED. The pre-lock is `ORDER BY c.id` and ids are
 * UUIDs, so creation order is not lock order — a caller staggering holders by
 * creation order would have the erasure block once on whichever row is
 * released last, and that single wait would blow the 2s `lock_timeout`.
 *
 * Distinct `startTime` per class so nothing trips a same-slot constraint.
 */
async function makeStudentWithClosedEntriesInClasses(classCount: number) {
  const suffix = `gdpr-budget-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Budget',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Budget fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Budget Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234BG',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    select: { id: true },
  });
  const student = await prisma.student.create({
    data: {
      firstName: 'Budget',
      lastName: 'Student',
      email: `${suffix}-student@test.local`,
      incomeTier: 2,
    },
    select: { id: true },
  });
  const classIds: string[] = [];
  for (let i = 0; i < classCount; i++) {
    const cls = await prisma.class.create({
      data: {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: `Budget class ${i}`,
        date: new Date('2099-06-01'),
        startTime: `${String(9 + i).padStart(2, '0')}:00`,
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'open',
      },
      select: { id: true },
    });
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: student.id, position: 1, status: 'expired' },
    });
    classIds.push(cls.id);
  }
  return {
    studentId: student.id,
    classIds: [...classIds].sort(),
    teacherId: teacher.id,
    roomId: room.id,
    accountId: teacher.accountId,
  };
}

/**
 * Tears down everything `makeStudentWithClosedEntriesInClasses` created.
 * Called from a `finally`, for the reason `cleanupStudentWaitingInClass`
 * above gives: an assertion failure mid-test must still reap the rows.
 *
 * `WaitlistEntry.class` is `onDelete: Cascade`, so surviving entries go with
 * their classes.
 */
async function cleanupStudentWithClosedEntries(
  fixture: Awaited<ReturnType<typeof makeStudentWithClosedEntriesInClasses>>,
): Promise<void> {
  await prisma.class.deleteMany({ where: { id: { in: fixture.classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: fixture.teacherId } });
  await prisma.room.deleteMany({ where: { id: fixture.roomId } });
  await prisma.student.deleteMany({ where: { id: fixture.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fixture.teacherId } });
  await prisma.account.deleteMany({ where: { id: fixture.accountId } });
}
```

- [ ] **Step 3: Add the test inside `describe('GDPR (DB)', …)`**

Put it immediately after the `it('bounds its wait even when the student is waiting in no classes at all', …)` test, which is the other budget-shaped case in that block.

```ts
  /**
   * #240. The erasure's transaction budget used to be sized from a count of
   * `waiting` entries only, so a student with none scored zero and got the
   * 5_000ms floor — against a pre-lock that still asks for one row lock per
   * class the student holds an entry in, of any status.
   *
   * The construction is fiddly for reasons worth stating, because a simpler
   * version of it proves nothing:
   *
   * - Six holders releasing 1.5s apart, NOT all at once. Simultaneous
   *   releases produce one ~1.5s wait, not six; the statement then finishes
   *   inside 5s and the old budget passes.
   * - Staggered by SORTED class id, because the pre-lock is `ORDER BY c.id`.
   *   Stagger by creation order and the erasure blocks once on whatever is
   *   released last, that single wait exceeds the 2s `lock_timeout`, and the
   *   FIXED code fails with `55P03`.
   * - `pg_sleep` inside the holding transaction, on an ABSOLUTE schedule
   *   computed from `t0`, rather than a JS timer per holder. The two margins
   *   pull against each other — total elapsed must clear 5_000ms or the old
   *   budget survives, and no single wait may reach 2_000ms or the new one
   *   dies — and a JS timer firing late spends the second margin directly.
   *   1.5s steps leave 500ms of headroom under the bound and ≈3.7s over the
   *   old budget.
   * - A DEDICATED client with an explicit `connection_limit`. Prisma's
   *   default pool is `physical_cores * 2 + 1`; on a two-core CI runner that
   *   is five, and six holders plus the erasure would deadlock waiting for
   *   connections rather than for locks — a failure that looks nothing like
   *   what this test is about.
   *
   * What it proves, precisely: an erasure whose lock waits total more than
   * the old floor now completes. Restore
   * `Math.min(5_000 + waitingCount * 2_000, 20_000)` and it fails with
   * `P2028`, which is #240 reproduced.
   */
  it('completes when its lock waits total more than the old 5s budget', async () => {
    const CLASSES = 6;
    const HOLD_STEP_MS = 1_500;
    const fixture = await makeStudentWithClosedEntriesInClasses(CLASSES);
    const baseUrl = process.env.DATABASE_URL ?? '';
    const holderDb = new PrismaClient({
      datasources: {
        db: { url: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}connection_limit=10` },
      },
    });
    try {
      const t0 = Date.now();
      const holders = fixture.classIds.map((classId, i) =>
        holderDb.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
            const seconds = Math.max(0, (t0 + (i + 1) * HOLD_STEP_MS - Date.now()) / 1000);
            // Computed, never input — `$queryRawUnsafe` because a bound
            // parameter into `pg_sleep` needs an explicit cast to resolve.
            await tx.$queryRawUnsafe(`SELECT pg_sleep(${seconds.toFixed(3)})`);
          },
          { timeout: 30_000, maxWait: 10_000 },
        ),
      );

      // Every holder must be sitting on its row before the erasure asks for
      // any of them, or the pre-lock sails through the ones not yet taken.
      await new Promise((r) => setTimeout(r, 300));

      await deleteStudentAccount(prisma, fixture.studentId);
      await Promise.all(holders);

      expect(
        await prisma.waitlistEntry.count({ where: { studentId: fixture.studentId } }),
      ).toBe(0);
      const erased = await prisma.student.findUniqueOrThrow({
        where: { id: fixture.studentId },
        select: { deletedAt: true },
      });
      expect(erased.deletedAt).not.toBeNull();
    } finally {
      await holderDb.$disconnect();
      await cleanupStudentWithClosedEntries(fixture);
    }
  }, 40_000);
```

- [ ] **Step 4: Run it and watch it FAIL — this is the reproduction**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t 'lock waits total more than the old 5s budget'`

Expected: **FAIL**, with a Prisma `P2028` transaction-expiry error. Prisma's exact wording varies by version — **record the verbatim message in the task ledger**, do not paraphrase it. It is the evidence #240 was real.

If it fails with `55P03 canceling statement due to lock timeout` instead, a single wait reached 2s: the stagger is wrong. Check that `classIds` is sorted and that the holders are mapped over the sorted array.

If it **passes**, stop and report. Either the statement finished inside 5s (raise `CLASSES` to 8 and re-measure) or Prisma is not enforcing the budget the way the code's comments claim, which would make the whole issue moot and is worth a gate.

- [ ] **Step 5: Commit the failing test**

```bash
git add src/services/gdpr.test.ts
git commit -m "test: reproduce the 5s floor a student with no waiting entries gets"
```

---

## Task 2: The fix

**Files:**
- Modify: `src/services/gdpr.ts` — delete `:279-318`, edit `:387-388`, replace `:631-736`

**Interfaces:**
- Consumes: nothing from Task 1 (the test is independent of this task's identifiers)
- Produces: no new exported symbols. `waitingCount` ceases to exist; nothing else references it — `grep -n waitingCount src/services/gdpr.ts` must return nothing after this task.

- [ ] **Step 1: Verify the three edit sites**

```bash
sed -n '279p;318p;387,388p;631p;736p' src/services/gdpr.ts
```

Expected, in order: `  // Sizes the transaction's own \`timeout\` below — see that option for the`; `  const waitingCount = await db.waitlistEntry.count({ where: { studentId, status: 'waiting' } });`; `    // was reachable, and reaching it was terminal rather than transient — see` / `    // \`waitingCount\` above.`; `    // Arithmetic (see \`waitingCount\` above for why the base term can't be a`; `    timeout: Math.min(5_000 + waitingCount * 2_000, 20_000),`. Report and correct any drift.

- [ ] **Step 2: Delete lines 279–318 entirely**

The whole comment block from `// Sizes the transaction's own \`timeout\` below` through and including the `const waitingCount = …` statement, plus the blank line after it if one is left. That single deletion covers four rows of the spec's §4 table (`:283`, `:289-298`, `:303-317`, and the query itself).

Line `320`'s `const freedClassIds = await db.$transaction(async (tx) => {` must now follow `:277`'s closing `});` with one blank line between.

- [ ] **Step 3: Re-point the cross-reference at the old `:387-388`**

Replace:

```ts
    // was reachable, and reaching it was terminal rather than transient — see
    // `waitingCount` above.
```

with:

```ts
    // was reachable, and reaching it was terminal rather than transient — see
    // this transaction's `timeout` option below.
```

- [ ] **Step 4: Replace the whole `timeout` comment and the option itself**

Everything from `// Arithmetic (see \`waitingCount\` above for why the base term can't be a` (was `:631`) through `timeout: Math.min(5_000 + waitingCount * 2_000, 20_000),` (was `:736`) becomes:

```ts
    // Flat, and that is a decision rather than a default. It used to be
    // `Math.min(5_000 + waitingCount * 2_000, 20_000)`, sized from a count read
    // before the transaction opened. The term is gone; the ceiling it rarely
    // reached is now the whole rule.
    //
    // WHY THE TERM COULD NOT BE MADE HONEST. It priced neither of the two
    // things that scale with the size of this erasure:
    //
    //   - It counted `waiting` entries, but the lock set is every class the
    //     student holds an entry in of ANY status — the pre-lock's join carries
    //     no status predicate, deliberately, see there. A student with 0
    //     `waiting` and 30 closed entries got 5_000ms against a statement
    //     asking for 30 row locks.
    //   - It did not count `reorderWaitingEntries` (`waitlist.ts`) at all: a
    //     `findMany` plus up to M individual `UPDATE`s per class, each
    //     separately bounded by the same 2s.
    //
    // A term that prices neither axis, and whose only possible effect is to
    // grant LESS than the ceiling already permits, is worse than the ceiling
    // alone. Computing it also cost a round trip before the transaction opened
    // and a documented stale-read window, because the count ran outside any
    // transaction and a waitlist join could land in the gap.
    //
    // AND THE ARGUMENT THAT KEPT IT `waiting`-ONLY WAS INVERTED, which is the
    // part worth reading before reviving it. Commit `7298311` reverted an
    // all-status count on the grounds that such a count is monotone for the
    // life of the account, so "past the `Math.min` ceiling the erasure would
    // fail, and the retry would re-read the same count and fail identically —
    // an account that can never be erased". That does not survive its own
    // arithmetic: `min(5_000 + N * 2_000, 20_000)` is monotone NON-DECREASING
    // in N and capped, so an all-status count could only ever grant MORE budget
    // than a `waiting`-only one for the same account, never less. It could not
    // have caused a failure the smaller count avoids. What actually made those
    // accounts un-erasable was the `lockClassRow` LOOP — two round trips per
    // class, measured at 6.0s against the single statement's 13ms for the same
    // class set. That commit removed the loop and reverted the count together,
    // and credited the wrong one.
    //
    // 20_000ms. Generous enough that the realistic case always finishes: this
    // is a single-teacher CRM tool with no plausible legitimate student waiting
    // in more than a handful of classes at once. Not all of this transaction's
    // work is indexed on the column it filters by, which is part of why the
    // ceiling is 20s and not 5 — `waitlistEntry.findMany`/`deleteMany` and
    // `teacherStudent.deleteMany` key on `studentId` alone, `magicLinkToken
    // .deleteMany` keys on `email`, and the teacher-notification `updateMany`
    // filters on `body: { startsWith }`: four sequential scans, verified
    // against `prisma/migrations/*/migration.sql` rather than assumed. Bounded
    // enough that a pathological N cannot hold one of this app's Postgres
    // connections any longer, on a deployment that is a single 2GB VPS
    // (`CLAUDE.md`: "VPS budget"). #238 is the root fix for the lock set
    // growing with account age: nothing reaps a closed, unfulfilled
    // `WaitlistEntry`, so the population only grows.
    //
    // WHAT THIS DOES NOT BOUND, and the distinction is why the number above is
    // not a guarantee. Prisma's interactive-transaction timeout refuses to
    // START a statement past the budget; it cannot cancel one already blocked
    // inside Postgres. Two consequences, both measured rather than read off the
    // docs:
    //
    //   - `lock_timeout` is armed PER LOCK ACQUISITION, not per statement, so
    //     the ordered pre-lock over N contended rows can spend up to N * 2s
    //     while no single wait exceeds the bound. Measured 2026-08-16: two
    //     `Class` rows held by sessions releasing at 1.5s and 3.0s, one waiter
    //     at `lock_timeout='2s'` taking both in ONE statement, SUCCEEDED after
    //     2.67s. What #237's helper collapses to O(1) is round trips, not
    //     waiting.
    //   - `SET LOCAL lock_timeout` governs every statement left in this
    //     transaction, not just the `FOR UPDATE`s. Measured with a lock on the
    //     erased student's own `Registration` row, unrelated to any waitlist:
    //     `registration.updateMany` failed at ~2086ms with `55P03 canceling
    //     statement due to lock timeout`. That bound arrives from
    //     `setLockTimeout` at the top of this transaction, unconditionally —
    //     before it did, a student waiting in zero classes got an UNBOUNDED
    //     wait, which is what made this ceiling a wish rather than a rule.
    //
    // So the honest claim: every WAIT here is bounded at 2s, this budget bounds
    // how long Prisma will keep STARTING statements, and neither bounds the
    // transaction's total time in the pathological case. When the budget does
    // bind, the erasure aborts with P2028 — safe and retryable, because this
    // function is one transaction end to end (its only work outside it is the
    // post-commit `handleSpotFreed` loop, which swallows its own errors), so a
    // throw means nothing landed. `api/account/route.ts`'s `erasureFailure`
    // relies on exactly that to tell the caller "Nothing was changed", and says
    // why the teacher erasure cannot claim the same.
    timeout: 20_000,
```

- [ ] **Step 5: Confirm the identifier is gone and the file compiles**

```bash
grep -n waitingCount src/services/gdpr.ts ; npx tsc --noEmit
```

Expected: the `grep` prints nothing (exit 1), `tsc` is silent.

- [ ] **Step 6: Run Task 1's test and watch it PASS**

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t 'lock waits total more than the old 5s budget'`

Expected: PASS, ≈9-10s.

- [ ] **Step 7: Run the whole gdpr suite**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`

Expected: all green, one more test than the 23 the file had before. The five-status `it.each` at `:400` must still pass untouched — it is #243's detector and this branch does not change what it watches.

- [ ] **Step 8: Mutation — prove the test can fail**

Temporarily restore the old budget. Add above the transaction:

```ts
  const waitingCount = await db.waitlistEntry.count({ where: { studentId, status: 'waiting' } });
```

and change the option back to `timeout: Math.min(5_000 + waitingCount * 2_000, 20_000),`.

Run: `npx vitest run --project unit src/services/gdpr.test.ts -t 'lock waits total more than the old 5s budget'`

Expected: **FAIL with `P2028`** — the same verbatim message recorded in Task 1 Step 4. Record it again and confirm the two match; a different failure mode means the test is failing for a different reason than the one it claims to detect.

**Then revert the mutation** and re-run to confirm green. Do not commit the mutation.

- [ ] **Step 9: Commit**

```bash
git add src/services/gdpr.ts
git commit -m "fix: the erasure's budget priced neither axis, so the ceiling is now the rule"
```

---

## Task 3: Correct the six artifacts that assert the removed claim

Five source files and one live reference doc still say the budget is sized. None is a comment-polish edit — each states something now false about how this transaction is bounded.

**Files:**
- Modify: `src/lib/db-locks.ts`, `src/lib/api-errors.ts`, `src/app/api/account/route.ts`, `src/app/api/class-templates/route.ts`, `docs/lock-order.md`

**Interfaces:**
- Consumes: Task 2's `timeout: 20_000`
- Produces: nothing. Comments and docs only; no code changes, so the suite's behaviour is unchanged.

- [ ] **Step 1: Re-derive the sweep rather than trusting the list**

```bash
grep -rn "sized" src docs/lock-order.md
grep -rn "waitingCount\|5_000 + " src docs/lock-order.md
```

Expected: hits in exactly the four source files and `docs/lock-order.md` named below, and **nothing left in `src/services/gdpr.ts`**. If a file appears that is not in this task's list, report it — the list was derived by reason, not by keyword, and a keyword can still find something the reasoning missed. (The reverse also happened: the first sweep used ``grep -rn "sized \`timeout\`"`` and missed `account/route.ts`, where the phrase wraps across a line break. Do not narrow the pattern.)

- [ ] **Step 2: `src/lib/db-locks.ts:161-165`**

Replace:

```
 * them hits its own timeout. `deleteStudentAccount` (`gdpr.ts`) is exactly
 * this caller, added in #174 Task 5 — its call site sizes the erasure
 * transaction's own `timeout` to the number of classes it is about to lock
 * rather than trusting the 5s default; the arithmetic lives there, not
 * here.
```

with:

```
 * them hits its own timeout. `deleteStudentAccount` (`gdpr.ts`) is exactly
 * this caller, added in #174 Task 5 — its transaction carries a flat
 * `{ timeout: 20_000 }` rather than the 5s default. It used to SIZE that
 * budget from the number of classes it was about to lock; #240 removed the
 * term, because it counted `waiting` entries while the lock set spans every
 * status, and priced none of the reorder loop. The reasoning lives there,
 * not here.
```

- [ ] **Step 3: `src/lib/api-errors.ts:122`**

Replace `` `deleteStudentAccount`'s sized `timeout` can hit under load `` with `` `deleteStudentAccount`'s flat 20s `timeout` can hit under load ``, keeping the surrounding sentence intact.

- [ ] **Step 4: `src/app/api/account/route.ts:27-28`**

Replace:

```
 * exactly one of them (`P2028` from `deleteStudentAccount`'s sized
 * `timeout`). Everything else that can escape those services will fail the
```

with:

```
 * exactly one of them (`P2028` from `deleteStudentAccount`'s flat 20s
 * `timeout`). Everything else that can escape those services will fail the
```

- [ ] **Step 5: `src/app/api/class-templates/route.ts:121-122`**

Replace:

```
      // **both GDPR erasures** — `deleteStudentAccount`'s sized
      // `Math.min(5_000 + waitingCount * 2_000, 20_000)` and
```

with:

```
      // **both GDPR erasures** — `deleteStudentAccount`'s flat
      // `{ timeout: 20_000 }` (sized until #240) and
```

Leave the following line (`` `deleteTeacherAccount`'s flat `{ timeout: 10_000 }` (`gdpr.ts`), both ``) unchanged.

- [ ] **Step 6: `docs/lock-order.md:700-710`**

Replace the sentence:

```
The single statement makes the lock cost
  O(1) statements, so the budget is sized by the reorder loop's `waiting` count,
  which drains on its own.
```

with:

```
The single statement makes the lock cost
  O(1) ROUND TRIPS — not O(1) waiting, which an earlier version of this
  sentence implied by saying "O(1) statements" and letting the budget be sized
  by the reorder loop's `waiting` count. `lock_timeout` is armed per lock
  acquisition, so one statement over N contended rows can still spend N × 2s
  (measured 2026-08-16: two rows, releases at 1.5s and 3.0s, one waiter at 2s,
  succeeded after 2.67s). #240 removed the sizing term for that reason; the
  budget is a flat `{ timeout: 20_000 }`.
```

Keep the surrounding sentences — the un-erasable-account history and the
read-then-lock window — as they are.

- [ ] **Step 7: `docs/lock-order.md:910` — the one with consequences elsewhere**

The parenthesis currently argues part of #229 on the grounds that `deleteStudentAccount` has a tuned budget where `deleteTeacherAccount` has a flat one. Replace:

```
(Not a *lock* timeout, and not the tuned one: the
sized budget, `Math.min(5_000 + waitingCount * 2_000, 20_000)`, belongs to
`deleteStudentAccount`. An earlier version of this sentence conflated the two,
which matters because the tuned budget is the one that would absorb a
re-ordering and the flat one is not.)
```

with:

```
(Not a *lock* timeout. This distinction used to carry
weight for #229: `deleteStudentAccount` had a TUNED budget,
`Math.min(5_000 + waitingCount * 2_000, 20_000)`, which was argued to be the
one that could absorb a re-ordering where a flat one could not. #240 removed
the term, so both erasures now carry flat budgets — `20_000` here, `10_000`
there — and that half of the argument no longer applies. What remains is the
raw size difference, which is a weaker reason than the one it replaces.)
```

- [ ] **Step 8: Reconcile the diff against the intended file list**

```bash
git diff --name-only
```

Expected exactly: `docs/lock-order.md`, `src/app/api/account/route.ts`, `src/app/api/class-templates/route.ts`, `src/lib/api-errors.ts`, `src/lib/db-locks.ts`.

**This step is the point of the task, not a formality.** A wave that fixes four of five reports success either way; reconciling the files it *did* change against the files it was *supposed* to change is the only thing that catches the fifth. If a file on the list is absent from the diff, it was skipped.

- [ ] **Step 9: Static gates**

Run: `npm run typecheck && npm run lint`

Expected: both clean. No test run is needed — this task changes only comments and Markdown.

- [ ] **Step 10: Commit**

```bash
git add docs/lock-order.md src/app/api/account/route.ts src/app/api/class-templates/route.ts src/lib/api-errors.ts src/lib/db-locks.ts
git commit -m "docs: six artifacts said the erasure budget was sized, and #229 leaned on it"
```

---

## Task 4: Verify and open the PR

**Files:** none modified.

- [ ] **Step 1: Confirm the dev server is up**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/ --max-time 5
```

Expected: a 2xx or 307. **Do not start it if it is down** — ask the user. The `integration` project talks to it over HTTP and without it you get a wall of `ECONNREFUSED`.

- [ ] **Step 2: Full verify**

Run: `npm run verify`

Expected: typecheck clean, lint clean, and **120 files / 1393 tests** green — one more test than the measured baseline of `54 + 38 + 28 = 120` files and `775 + 207 + 410 = 1392` tests, in the existing `gdpr.test.ts`. **Record the actual figures.** The predicted number has been wrong before on this project for reasons a prediction could not know.

Green `verify` is not a substitute for CI: CI also runs `prisma validate`, a migration-drift check, `npm run build`, and Playwright. This branch touches no schema and adds no imports, so a build-only failure is unlikely — but "unlikely" is why it is stated rather than assumed.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin erasure-budget
```

Then open the PR with `gh pr create --body-file <path>`, **never** `--body "…"` — backticks inside a double-quoted shell string reach zsh as command substitution and fail silently, publishing mangled prose.

The body must record:

- what was measured, including the baseline arithmetic and the after-figure;
- that #240's stated facts all held, and that the finding it did **not** contain — the inverted argument at the old `gdpr.ts:289-298` — is most of the branch's value;
- the verbatim `P2028` text from Task 1 Step 4 and Task 2 Step 8, as the reproduction and the mutation;
- that the sweep was derived by reason and that a narrower keyword pattern missed `account/route.ts` because the phrase wraps;
- that `docs/lock-order.md:910` change weakens half of an argument #229 rests on;
- which suites ran, with the arithmetic proving `integration` ran in full;
- what the branch does **not** do: no scoping of the `waitlistEntry.deleteMany`, no capture of `lockClassRowsOrdered`'s return, no edit to `db-locks.ts:286-291`.

**Write `Closes #240`. For the other issue write "#243 is unaffected by this branch" — never `does not close #<number>`.** GitHub's parser matches the keyword and ignores the negation in front of it; PR #191 closed issue 113 that way, and the commit written to document that trap closed it a second time by quoting the phrase verbatim. Separate the keyword from the number or write the number as prose.

- [ ] **Step 4: Review gate**

Stop here and hand back. `/pr-review-toolkit:review-pr <N>` is the user's call, not this plan's.

---

## Self-review

**Spec coverage.** §2's flat budget → Task 2 Step 4. §2's five must-keep measurements → all present in Task 2 Step 4's replacement text (per-acquisition `lock_timeout` + the 2.67s measurement; `SET LOCAL` scope + the ~2086ms `55P03`; the 2GB VPS; P2028 retryability; #238 as root fix). §2's must-add correction → the "AND THE ARGUMENT … WAS INVERTED" paragraph. §2's must-not-claim → the "WHAT THIS DOES NOT BOUND" paragraph. §3's G1 and its three traps → Task 1 Steps 2-4, each trap named in the test's own docblock so it survives the plan. §3's "do not rewrite `gdpr.test.ts:400`" → Task 2 Step 7 and the Global Constraints. §4's eleven rows → four collapse into Task 2 Step 2's single deletion, two more are Task 2 Steps 3-4, the remaining five are Task 3. §5's out-of-scope list → Global Constraints. §6's risks → Task 1 Step 4's three named failure modes and Task 4 Step 2's "record the actual figures".

**Placeholders.** None. Every code step carries the literal text.

**Type consistency.** `makeStudentWithClosedEntriesInClasses` is defined once and referenced twice, with `cleanupStudentWithClosedEntries` taking `Awaited<ReturnType<…>>` exactly as the existing `cleanupStudentWaitingInClass` does.

**One error this review caught, recorded because it is the kind that ships.** The first draft gave the fixture `accountId: string | null` and guarded the cleanup's `account.deleteMany` behind `if (fixture.accountId)`, with a self-review paragraph explaining why the guard was prudent. `Teacher.accountId` is `String @unique` (`schema.prisma:127`) — non-nullable. The nullable one is `Student.accountId` (`:165`). So the type was wrong, the guard was unreachable, and the paragraph justifying it was reasoning from a fact nobody had checked. Both are corrected above. The general shape — a plausible defensive branch, plus prose arguing for it, neither grounded in the schema — is worth watching for in review, because it reads as care.

**Test-count anchor, measured not assumed.** `npx vitest run --project unit src/services/gdpr.test.ts` → **23 tests** before this branch. Task 2 Step 7's "one more than 23" is that figure, re-derived on 2026-08-16.

**One gap accepted deliberately.** Task 3 changes no behaviour, so nothing proves those six edits are right beyond reading them. That is inherent to a documentation correction, and Step 8's diff reconciliation is the substitute: it cannot check that the new prose is true, only that no file was silently skipped.

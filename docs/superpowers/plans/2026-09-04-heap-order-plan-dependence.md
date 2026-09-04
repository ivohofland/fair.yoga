# Deterministic lock-order premises in `template-lock-order.test.ts` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two premise probes in `src/services/template-lock-order.test.ts` deterministic, so the file's adversarial fixture is owned by the test rather than by the query planner and the physical heap.

**Architecture:** Assign the keys that *both* viable forced plans order by — `Class.calendarEntryId` and `CalendarEntry.date` — so the two index-nested-loop directions agree on `[HIGH, LOW]`; then wrap each probe in the three `SET LOCAL` planner settings, written inline. The fixture already assigns class ids and dates; this adds the entry ids and the plan pin.

**Tech Stack:** Vitest (`unit-sweeps` project, serial), Prisma raw SQL, PostgreSQL in `fairyoga-db-1`.

**Spec:** None — the spec gate was deliberately skipped (one test file, no production code, the design question settled at the brainstorming gate). The issue is the source: `gh issue view 441`. Prior art this mirrors: `src/lib/db-locks-lock-order.test.ts` (`forceIndexOrderedPlan` and its docblock) and commit `f0e289ca` (#239).

## Global Constraints

- **Test-only.** No production code, no schema change, no migration. `src/lib/db-locks.ts` and `src/services/rule-lifecycle.ts` are untouched.
- **Mirror, do not import.** The three `SET LOCAL`s are written inline in this file. Recorded decision, `src/services/gdpr-lock-order.test.ts:228-230`: *"a test helper crossing suites would couple two files whose fixtures are independent."* Do not extract a helper that crosses files. A file-local helper consolidating this file's own call sites — `expectPremiseOrder`, which the review of this work introduced — is not what this constraint forbids: what it protects is the independence of the two files' fixtures, not intra-file de-duplication.
- **Comments state what is true now** (CLAUDE.md, *Comment Discipline*). No "this previously read X". Correction history goes in the PR body.
- **A comment annotates the code it sits on.** Claims about `db-locks-lock-order.test.ts`'s measurements are cited by name, not restated with numbers.
- **Worktree limits.** `integration` and `e2e` cannot run here (both need the dev server on `:3000` and the shared dev DB). Scope local verification to typecheck, lint, `unit`, `unit-sweeps`, `components`; cite the CI run for the other tiers.
- **Measured numbers live in the PR body**, not in a docblock.

---

### Task 1: Make both premises deterministic

**Files:**
- Modify: `src/services/template-lock-order.test.ts` — fixture at `:140-289`, probes at `:420-426` and `:599-605`

**Interfaces:**
- Consumes: `createClassFixture` from `tests/class-fixtures` — already imported; its optional `calendarEntryId?: string` parameter (`tests/class-fixtures.ts:37`) is what this task starts passing.
- Produces: nothing importable. Task 2 depends on the two probes reading through a forced plan and on the fixture assigning entry ids.

- [ ] **Step 1: Assign the entry ids in the fixture**

In `makeTemplateWithTwoWaitedInstances`, directly below the existing `lowClassId` / `highClassId` declarations, add:

```ts
    // Entry ids assigned for the same reason the class ids above are, and
    // against a second source of drift. The premise probes in each `it` read
    // under a forced index-nested-loop plan, and that plan has two shapes
    // here: driven from `Class` through `Class_calendarEntryId_key`, ordering
    // by `calendarEntryId`, or driven from `ClassTemplate` through
    // `CalendarEntry_scheduleRuleId_date_key`, ordering by `date`. Which one
    // wins is a cost decision that moves with table size. Assigning the entry
    // ids makes the first shape's order the one this fixture chose; the dates
    // below already make the second shape's order the same. The two therefore
    // agree, and the premise holds whichever direction the planner takes.
    //
    // HIGH takes the LOW entry id: HIGH is the row that must come FIRST.
    const highEntryId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    const lowEntryId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
```

- [ ] **Step 2: Pass them, and retire the heap claim in the insertion comment**

Replace the comment block above the two `createClassFixture` calls, and the calls themselves, with:

```ts
    // HIGH first, and HIGH dated earlier, and HIGH holding the lower entry id
    // — three statements of one fact: HIGH is the row a `Class` writer with no
    // explicit order reaches first, so `archiveOrUnarchiveTemplate`'s
    // `deleteMany` visits [HIGH, LOW] while `deleteStudentAccount`'s sorted
    // lock loop visits [LOW, HIGH]. Only the last two are load-bearing;
    // insertion order is not a property this table can carry, because `Class`
    // shares a page with every other file in this tier (the reasoning is
    // `db-locks-lock-order.test.ts`'s, in the docblock above
    // `forceIndexOrderedPlan`). Each `it` asserts the order rather than
    // assuming it.
    await createClassFixture(prisma, {
      ...classBase,
      id: highClassId,
      calendarEntryId: highEntryId,
      date: futureDate(jsDayOfWeek, 2),
    });
    // LOW is `draft`, HIGH is `open` — one of each of `SCHEDULED_STATUSES`,
    // deliberately, and specifically `draft` on the row that must be locked
    // FIRST for the order to hold.
    //
    // Both statuses are equally valid here (`draft` and `open` are both
    // delete candidates for the archive, so every count below is unchanged),
    // but a fixture that used only `open` could not observe the pre-lock's
    // status list at all. `archiveOrUnarchiveTemplate`'s pre-lock renders that
    // list from `SCHEDULED_STATUSES` into raw SQL, and dropping `'draft'` from
    // it left every test covering that function green while the deadlock
    // reopened — measured during issue 180 task 4. With LOW as `draft`, a
    // narrowed list skips the row the erasure takes first, and the archive
    // `it` below fails.
    await createClassFixture(prisma, {
      ...classBase,
      id: lowClassId,
      calendarEntryId: lowEntryId,
      status: 'draft',
      date: futureDate(jsDayOfWeek, 3),
    });
```

- [ ] **Step 3: Force the plan at both probes, and rename the variable**

At `:420` and again at `:599`, replace the bare `heapOrder` read with the forced-plan read. Identical text in both places — the name `heapOrder` goes, because the heap is exactly what this no longer reads:

```ts
      // The premise, asserted rather than assumed: HIGH comes first, which is
      // what makes the race adversarial. Read under a forced index-nested-loop
      // plan, because an unforced read here is a cost decision — `enable_hashjoin`
      // alone removes a join ALGORITHM, not a join DIRECTION, and the direction
      // is non-monotonic in table size. The three settings and the measurements
      // behind them are `db-locks-lock-order.test.ts`'s `forceIndexOrderedPlan`,
      // mirrored rather than imported so the two files' fixtures stay
      // independent. `SET LOCAL` is transaction-scoped and `enable_seqscan = off`
      // discourages rather than forbids, so neither reaches production nor can
      // make this statement fail. Re-read per `it` because each builds its own
      // fixture with fresh ids.
      const premiseOrder = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
        await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        return tx.$queryRaw<Array<{ id: string }>>`
          SELECT c.id FROM "Class" c
          JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
          JOIN "ClassTemplate" ct ON ct."scheduleRuleId" = e."scheduleRuleId"
          WHERE ct."id" = ${templateId}
        `;
      });
      expect(premiseOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);
```

- [ ] **Step 4: Sweep the file for claims this task made false**

The words `heap`, `heapOrder`, `physical order`, and `insertion order` appear in this file's prose beyond the two sites edited above, including in the repeated blocks near `:453`, `:469`, `:654` and `:670`. Run:

```bash
grep -n "heapOrder\|heap order\|physical order\|insertion order" src/services/template-lock-order.test.ts
```

Give every hit a verdict. A claim that the fixture's order comes from the heap is now false and is replaced by what is true — the order is assigned. A claim about `ORDER BY c.id` on the erasure side is untouched by this task and stays. Do not annotate; replace.

- [ ] **Step 5: Verify — the file passes**

```bash
npx vitest run --project unit-sweeps src/services/template-lock-order.test.ts
```
Expected: `Test Files 1 passed (1)`, `Tests 2 passed (2)`.

- [ ] **Step 6: Verify — nothing else in the tier moved**

```bash
npx vitest run --project unit-sweeps
```
Expected: all files pass. `db-locks-lock-order.test.ts` and `gdpr-lock-order.test.ts` are the neighbours most likely to notice a shared-table change; both must stay green.

- [ ] **Step 7: Commit**

```bash
git add src/services/template-lock-order.test.ts
git commit -m "test(lock-order): the premise is assigned, not read off the heap (#441)"
```

---

### Task 2: Prove the premise can fail

**Files:**
- Modify: `src/services/template-lock-order.test.ts` (comment corrections only, if Task 1 Step 4 left any)
- Create: nothing committed. The measurement scripts below are throwaway; results go in the PR body.

**Interfaces:**
- Consumes: Task 1's assigned entry ids and forced-plan probes.
- Produces: the measured numbers the PR body cites.

- [ ] **Step 1: Mutation — swap the assigned entry ids**

In the fixture, swap the two constants so HIGH takes the *higher* entry id:

```ts
    const highEntryId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    const lowEntryId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
```

- [ ] **Step 2: Run, and record the exact failure text**

```bash
npx vitest run --project unit-sweeps src/services/template-lock-order.test.ts
```
Copy the verbatim `AssertionError` block into the PR body for whichever mutation fails.

A passing run here is not a defect, and must not be read as one. The entry-id swap only fails under a `Class`-driven plan ordered by `calendarEntryId`; under a `ClassTemplate`- or `CalendarEntry`-driven plan the output is ordered by `CalendarEntry.date`, which this swap does not touch, so the probe passes while working exactly as designed. The mutation that fails under **every** shape observed so far is the **date** swap — exchange the two `futureDate(jsDayOfWeek, …)` arguments on the `createClassFixture` calls instead. Cite that one as the evidence the premise can fail; cite the entry-id swap only alongside the plan shape it is sensitive to.

- [ ] **Step 3: Restore, and re-verify**

Revert Step 1's swap. Re-run the command from Step 2 and confirm both tests pass again.

- [ ] **Step 4: Measure across background row counts**

The direction the planner drives is a cost decision that moves with table size (#239 measured exactly this on the sibling), so one green run proves nothing about CI. Simulating the size beats inserting rows: the `yoga` role owns these tables and can write `pg_class` directly, so no filler data and no cleanup are needed.

Write this to a scratchpad file and run it with
`docker exec -i fairyoga-db-1 psql -U yoga -d ethical_yoga_test -f - < <file>`, repeating the block for each of `reltuples` = `0, 2, 10, 50, 200, 1000, 5000, 50000` (`relpages` roughly `reltuples/100 + 1`):

```sql
\echo '--- reltuples=0'
BEGIN;
UPDATE pg_class SET reltuples = 0, relpages = 1 WHERE relname = 'Class';
SET LOCAL enable_hashjoin = off; SET LOCAL enable_mergejoin = off; SET LOCAL enable_seqscan = off;
EXPLAIN SELECT c.id FROM "Class" c
  JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
  JOIN "ClassTemplate" ct ON ct."scheduleRuleId" = e."scheduleRuleId"
 WHERE ct."id" = 'x';
ROLLBACK;
```

The `ROLLBACK` is what makes this safe — the statistics change never commits.

Expected, measured on 2026-09-04 and to be reproduced:

| `reltuples('Class')` | driving side | output order |
|---|---|---|
| 0 | `Class` via `Class_calendarEntryId_key` | `Class.calendarEntryId` ascending |
| 2 … 50000 | `ClassTemplate` → `CalendarEntry_scheduleRuleId_date_key` → `Class` | `CalendarEntry.date` ascending |

Confirm the run reproduces that boundary, and note that the shapes above are the ones observed rather than the ones possible — a third has been seen on this database, driven from `CalendarEntry`, with `ClassTemplate` innermost, and it too orders by `CalendarEntry.date`. The set is not closed and nothing here should be written as though it were.

What the design rests on is narrower and survives a fourth shape: every shape observed orders by a key Task 1 assigns — `calendarEntryId` where `Class` drives, `date` otherwise — so the premise holds under each. Record the table, and the shapes behind it, in the PR body. If a shape appears that orders by something the fixture does not assign, stop and report: that is the case the design does not cover.

- [ ] **Step 5: Measure against an inverted heap**

Repeat the probe with the two `createClassFixture` calls swapped in order (LOW inserted first), keys unchanged. Expected: `[HIGH, LOW]` still, because the order is now assigned rather than physical. Run it 12 times, mirroring the sibling's own inverted-heap evidence. Record the count in the PR body. Restore the insertion order afterwards — it is no longer load-bearing, but the comment in Task 1 Step 2 describes the file as written.

- [ ] **Step 6: Confirm the tests still detect what they exist to detect**

The file's stated mutation target is an archive-side pre-lock revert. In `src/lib/db-locks.ts`, delete `ORDER BY c.id` from `lockClassRowsOrdered` and run:

```bash
npx vitest run --project unit-sweeps src/services/template-lock-order.test.ts src/lib/db-locks-lock-order.test.ts
```
Record which tests fail and at which assertion. Restore the clause and re-run to confirm green. This measures, it does not gate: `db-locks-lock-order.test.ts` documents that this file's reproductions no longer construct an AB-BA cycle and that the deadlock fires racily. Report the observed rate in the PR body rather than asserting a number in a comment.

- [ ] **Step 7: Verify the whole local surface**

```bash
npx tsc --noEmit && npm run lint && npx vitest run --project unit --project unit-sweeps --project components
```
Expected: clean typecheck, clean lint, all three projects pass. `integration` and `e2e` are not runnable in a worktree — CI covers them.

Use `npm run lint` (the project's own script, which runs `eslint`). `next lint` was removed in Next 16 and fails with `Invalid project directory provided, no such directory: …/lint`.

- [ ] **Step 8: Commit**

```bash
git add src/services/template-lock-order.test.ts
git commit -m "test(lock-order): record what the assigned premise catches, and what it does not (#441)"
```

---

## Finishing

- Update issue #441's body: it named only the join-plan mechanism, and missed both the heap-churn mechanism and the two-part shape of the sibling's fix. Correct it in place rather than appending a comment that contradicts the body (CLAUDE.md, *Comment Discipline*, applied to the tracker).
- PR body carries: the measured N → order table, the inverted-heap count, the verbatim mutation failure text, the observed archive-side revert rate, and the arithmetic behind the census (7 unordered raw id-list reads in tests = 4 pinned siblings + 1 that asserts no order + 2 fixed here). Cite the CI run for `integration` and `e2e`.

  The census is of the tree this branch starts from, so it re-derives against the merge base:

  ```bash
  git grep -n 'queryRaw<Array<{ id: string }>>' "$(git merge-base HEAD main)" -- 'src/*.test.ts'
  ```

  Seven lines. Against HEAD the same command returns six, because the two reads in `template-lock-order.test.ts` now share one file-local helper called once per `it`.

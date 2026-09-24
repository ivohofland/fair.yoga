# Pre-lock row-set test replaces template-lock-order's deadlock tests (#448)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `src/services/template-lock-order.test.ts`'s two "does not deadlock" tests, which cannot fail, with one deterministic test that pins the archive pre-lock's row set, and remove every live reference to the deleted file.

**Architecture:** Test-only change. The new test goes in `class-template-lifecycle.test.ts`'s `archiveOrUnarchiveTemplate (DB)` describe. It spies on `lockClassRowsOrdered` and asserts that the pre-lock locked every class the archive's delete took. It uses the same spy shape as that describe's existing scope-decoy test, "locks only the archived rule's own classes". No erasure, no timing, no serial tier.

**Tech Stack:** Vitest 4 (`vi.spyOn`, `onTestFinished`), Prisma client extensions (`$extends` query hooks), PostgreSQL test database `ethical_yoga_test`.

**Spec:** None. The issue was classified bounded, and the design was approved in chat. The measurements behind it go in the PR body and are summarised here:

- **Measured timeline (both current `it`s).** The erasure's `$queryRaw` hook sleeps 300 ms *before* its first lock. The archive starts at the signal and commits at T+47 to T+105 ms. The erasure takes its Student lock at T+~310, so the two transactions never overlap and no lock is ever contended.
- **Hook drift.** The hook keys on `args.values[0] === studentId`. Since #183 that matches `lockStudentForErasure`'s `SELECT id FROM "Student" … FOR NO KEY UPDATE` first, then `lockClassRowsOrdered`'s statement. It fires twice.
- **Mutations, all green before this branch:**
  - `c.status IN ('open')`: `template-lock-order` 3/3 runs, `class-template-lifecycle.test.ts` 74, and the three lock-order files together 21.
  - `AND NOT EXISTS (… Registration … 'registered')`: the same files, with 5/5 runs of `template-lock-order`.
- **Existing coverage that makes the old `it`s' remaining content redundant.** The `class-template-lifecycle.test.ts` tests titled:
  - "deletes a future draft class, like an open one"
  - "notifies a waiter whose class became deletable after the candidate read" (#112)
  - "reports deleted and remaining counts"

  Lock ordering is pinned by `src/lib/db-locks-lock-order.test.ts`.

## Global Constraints

- TypeScript `strict: true`; no `any`.
- Comment discipline (`CLAUDE.md`, *Comment Discipline*):
  - A comment annotates the code it sits on.
  - No counts or member rosters in comments.
  - No "this previously read X" history; that belongs in the PR body.
- `docs/superpowers/**` files are dated records. **Do not edit them**, even where they name the deleted file.
- Never `git add -A` / `git add .`; stage exact paths.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

---

### Task 1: The pre-lock-covers-delete test, proven against the narrowings

**Files:**
- Modify: `src/services/class-template-lifecycle.test.ts`. Insert a new `it`, with its docblock, directly after the `it` titled "locks only the archived rule's own classes" in `describe('archiveOrUnarchiveTemplate (DB)')`.
- Mutate temporarily, then restore: `src/services/class-template-lifecycle.ts`, the `lockClassRowsOrdered(tx, { … })` call inside `CLASS_FAMILY.withdraw.around`.

**Interfaces:**
- Consumes, all in scope inside that describe: `makeTemplate(classType)`, `makeClass(scheduleRuleId, { date, status? })`, `register(classId, studentId, status)`, `futureOn(days)`, `expectArchived(result)`, `teacherId`, `studentId`, `prisma`. From imports already present: `dbLocks`, `vi`, `onTestFinished`, `archiveOrUnarchiveTemplate`.
- Produces: the test title **"locks every class the delete takes, including one that became deletable mid-transaction"**. Task 2 points the production comment at this exact title.

- [ ] **Step 1: Add the test.**

```ts
  /**
   * The pre-lock's ROW SET, from the other side of the scope decoy above: that
   * test proves the pre-lock takes nothing outside its rule, this one that it
   * takes everything the delete does. The delete re-evaluates its predicate
   * when it runs, so a class it takes that the pre-lock did not is locked late,
   * out of the ascending order the pre-lock exists to impose.
   *
   * One class per narrowing that would drop it from the pre-lock:
   *   - a `draft` class — a status list narrowed to `open` skips it;
   *   - a class whose charged registration is cancelled after the candidate
   *     read — a pre-lock narrowed to what is deletable when it runs skips
   *     it, and the delete takes it anyway.
   *
   * Asserted on the lock set rather than by staging a deadlock: the set is
   * what a narrowing changes, and reading it needs no second transaction.
   */
  it('locks every class the delete takes, including one that became deletable mid-transaction', async () => {
    const t = await makeTemplate('Pre-lock Covers Delete');
    const draft = await makeClass(t.scheduleRuleId, { date: futureOn(5), status: 'draft' });
    const booked = await makeClass(t.scheduleRuleId, { date: futureOn(6) });
    const reg = await register(booked.id, studentId, 'registered'); // charged — not deletable yet

    const original = dbLocks.lockClassRowsOrdered;
    const lockSets: string[][] = [];
    const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
      const ids = await original(tx, source);
      lockSets.push(ids);
      return ids;
    });
    onTestFinished(() => spy.mockRestore());

    let calls = 0;
    const interposing = prisma.$extends({
      query: {
        waitlistEntry: {
          async findMany({ args, query }) {
            calls++;
            const rows = await query(args);
            if (calls === 1) {
              // Committed from OUTSIDE the archive transaction, after the
              // pre-lock ran: `cancelled` is not in `CHARGED_STATUSES`, so the
              // delete's predicate now matches this class.
              await prisma.registration.update({
                where: { id: reg.id },
                data: { status: 'cancelled', cancelledAt: new Date() },
              });
            }
            return rows;
          },
        },
      },
    }) as unknown as typeof prisma;

    const result = expectArchived(
      await archiveOrUnarchiveTemplate(interposing, t.id, teacherId, 'archived'),
    );

    // The cancel landed between the pre-lock and the delete, and the delete
    // took both classes — without these the lock-set assertion is about an
    // archive that withdrew less than this test staged.
    expect(calls).toBe(1);
    expect(result.deleted).toBe(2);
    expect(await prisma.class.count({ where: { id: { in: [draft.id, booked.id] } } })).toBe(0);

    expect(lockSets).toHaveLength(1);
    expect([...lockSets[0]].sort()).toEqual([draft.id, booked.id].sort());
  });
```

  If `calls` is not 1 or `deleted` is not 2 on unmutated code, **stop and report**. Don't loosen the assertion; the fixture premise is what's wrong.

- [ ] **Step 2: Run it green on unmodified production code.**

  Run: `pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts`
  Expected: every test passes, the new one included.

- [ ] **Step 3: Commit the test** before any mutation, so a later restore can't discard it:

```bash
git add src/services/class-template-lifecycle.test.ts
git commit -m "test(templates): the archive pre-lock locks every class its delete takes (#448)"
```

- [ ] **Step 4: Mutation M1 (status narrowing).** In `class-template-lifecycle.ts`, in the `lockClassRowsOrdered` call inside `CLASS_FAMILY.withdraw.around`, replace the exact text
  `AND c.status IN (${SCHEDULED_STATUSES_SQL})`
  with
  `AND c.status IN ('open')`.
  Run the Step 2 command. Expected: the new test **fails** on the lock-set assertion, with the draft class's id missing. Record the exact failure text. Restore with `git checkout -- src/services/class-template-lifecycle.ts`.

- [ ] **Step 5: Mutation M2 (deletable-only narrowing).** In the same `where`, append a line after `AND c.status IN (${SCHEDULED_STATUSES_SQL})`:
  `AND NOT EXISTS (SELECT 1 FROM "Registration" r WHERE r."classId" = c.id AND r.status = 'registered')`.
  Run the Step 2 command. Expected: the new test **fails** on the lock-set assertion, with the booked class's id missing. Record the exact text, then restore as in Step 4.

- [ ] **Step 6: Mutation M3 (no pre-lock).** Delete the whole `await lockClassRowsOrdered(tx, { … });` statement in `CLASS_FAMILY.withdraw.around`. Run the Step 2 command. Expected: the new test **fails** at `expect(lockSets).toHaveLength(1)`. Record, then restore.

- [ ] **Step 7: Record where the remaining two old-target mutations are caught.** No code change and no fix in this task.
  - **M4:** delete `FOR UPDATE OF c` from `lockClassRowsOrdered`'s first statement in `src/lib/db-locks.ts`. Run `pnpm exec vitest run --project unit src/lib/db-locks.test.ts` and `pnpm exec vitest run --project unit-sweeps src/lib/db-locks-lock-order.test.ts`.
  - **M5:** delete `ORDER BY c.id` from the same statement. Run the same two commands.

  For each, record which file(s) fail, with the failure text, or that none do. Restore `src/lib/db-locks.ts` after each. The new test is not expected to catch M4 or M5: the spy reads the ids a statement returned, not how it locked them.

- [ ] **Step 8: Prove the tree is clean.** `git status --porcelain` prints nothing, and `git diff HEAD --stat` is empty. Put the M1 to M5 results table in the task report.

---

### Task 2: Delete the file and give every reference a verdict

**Files:**
- Delete: `src/services/template-lock-order.test.ts`
- Modify (one verdict each; line numbers are as of `origin/main` 13286654, so find each by its text):
  - `vitest.tiers.ts`, two sites: the `LOCK_CONTENTION_TESTS` entry, and the header comment's example. Remove the entry. Retarget the example to `src/lib/db-locks-lock-order.test.ts`, whose `@serial-tier` header carries the same "neither `40P01` nor `55P03`" reason.
  - `src/services/room-archive-lock-order.test.ts`, the header paragraph beginning "SEPARATE FROM `room-archive.test.ts` FOR A REASON…". Its measurement is about the deleted file. Rewrite it to state only what is true of this file now: it holds real row locks for seconds, which is noise to any parallel tier, and that is why it is on `LOCK_CONTENTION_TESTS`. Drop the deleted file's name and the measurement about it.
  - `src/services/class-template-lifecycle.ts`, the comment in `CLASS_FAMILY.withdraw.around` beginning "`template-lock-order.test.ts`'s deadlock fixtures cannot show this". Rewrite it to say that the test titled "locks every class the delete takes, including one that became deletable mid-transaction" (`class-template-lifecycle.test.ts`) pins the wide row set by its lock set. Keep the pointer to the atomic-template-update spec §4 as where the `40P01` reproduction under a narrowed pre-lock is recorded; that spec exists and has a §4. Read the whole comment block around it and keep everything else that is still true.
  - `src/services/gdpr-lock-order.test.ts`, the trailing line-comment block beginning "The two `Class` lock-order deadlock cycles once tracked here by `it.todo` markers". It describes tests that no longer exist. Delete the whole block, down to and including its "A line comment, not a `/** */` docblock" paragraph.
  - `src/lib/db-locks-lock-order.test.ts`, the docblock sentence naming "the per-pairing reproductions in `template-lock-order.test.ts`". Keep the argument, and drop the file name and the "(verified: deleting it leaves them green)" parenthetical. With both sides taking every lock in one ordered statement, a per-pairing reproduction cannot construct an AB-BA cycle, so the shared primitive is tested once.
  - `src/lib/db-locks.test.ts`, "the convention `template-lock-order.test.ts:154-155` uses". Drop the attribution and keep "Ids chosen so ascending-by-id is knowable in advance".
  - `src/services/class-template-lifecycle.test.ts`, "Cast for the same reason `template-lock-order.test.ts`'s hooked clients need one". Drop the attribution and keep the stated reason. Read the rest of that comment, including its "(Not `template-sync.test.ts`, …" parenthetical, and keep it only if it is still true of this file.
  - `src/services/update-class-lock-order.test.ts`, "the same cast `template-lock-order.test.ts` uses for its hooked clients". Drop the attribution and keep the reason.
  - `docs/lock-order.md`, "a lock-taking node to the ordering `template-lock-order.test.ts` defends". Replace the file name with what the ordering *is*: the within-`Class` ascending-id order that document's own within-`Class` rule states. Read the paragraph to phrase it.

**Interfaces:**
- Consumes: Task 1's test title, verbatim.
- Produces: nothing later tasks use.

- [ ] **Step 1: Delete the file and remove the `LOCK_CONTENTION_TESTS` entry.** Run `pnpm exec vitest run --project unit src/lib/serial-tier-membership.test.ts`. Expected: pass. If the membership test names the deleted file, the list and the file are out of step; fix the list, not the test.

- [ ] **Step 2: Apply the other verdicts above,** one per site. The references come to 10 lines in 9 files: `vitest.tiers.ts` has 2, and each of the other 8 files has 1, so 2 + 8 = 10.

- [ ] **Step 3: Sweep for what was invalidated.**
  `git grep -n "template-lock-order" -- ':!docs/superpowers'` should print **nothing**. Then:
  `git grep -n "makeTemplateWithTwoWaitedInstances\|expectPremiseOrder\|only becomes deletable mid-transaction\|ordered pre-lock) vs deleteStudentAccount" -- ':!docs/superpowers'`
  should print nothing either. Every hit on either command gets a verdict in the report.

- [ ] **Step 4: Re-read every edited comment in full,** not just the edited line. A grep finds a stale *name*, never a stale *description*.

- [ ] **Step 5: Verify.**
  - `pnpm run typecheck`, then `pnpm run lint`. Expected: clean.
  - `pnpm exec vitest run --project unit src/services/class-template-lifecycle.test.ts src/lib/db-locks.test.ts src/lib/serial-tier-membership.test.ts`. Expected: pass.
  - `pnpm exec vitest run --project unit-sweeps src/lib/db-locks-lock-order.test.ts src/services/gdpr-lock-order.test.ts src/services/room-archive-lock-order.test.ts src/services/update-class-lock-order.test.ts`. Expected: pass.

- [ ] **Step 6: Commit.**

```bash
git rm src/services/template-lock-order.test.ts
git add vitest.tiers.ts src/services/room-archive-lock-order.test.ts src/services/class-template-lifecycle.ts src/services/gdpr-lock-order.test.ts src/lib/db-locks-lock-order.test.ts src/lib/db-locks.test.ts src/services/class-template-lifecycle.test.ts src/services/update-class-lock-order.test.ts docs/lock-order.md
git commit -m "test(templates): delete template-lock-order's deadlock tests, which could not fail (#448)"
```

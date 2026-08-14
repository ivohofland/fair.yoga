# Mutation records — template lock-race reporting (issue 113)

Each task records the exact error text every guard mutation produced, then
restores and re-verifies. Created in Task 1; appended to by Tasks 2-4, and
again by the multi-agent review round that followed them.

## Task 1

Baseline (pre-fix) failure, recorded 2026-08-14:

- Plan Step 2 predicted the archive "waits the claim out and resolves
  `{ ok: true, action: 'archived', ... }`" so `toEqual` fails. Actual failure:
  the test times out in 20 s because the release only fires after the archive
  settles, and the pre-fix archive never settles (the claim holds the row for
  the whole test). Same conclusion — the test only passes once the archive
  answers `busy` within the lock window — different shape. Recorded here so
  the Task 1 mutation record stays honest.

- Step 10 (comment out `await setLockTimeout(tx);`): FAIL, same shape as the
  baseline. `Error: Test timed out in 20000ms.` at
  `src/services/class-generator.test.ts:394` (`answers busy when the
  generation claim holds the row past the lock timeout`), with the
  `afterEach` hook also timing out (`Hook timed out in 10000ms`) because the
  claim still holds the row when the test aborts. The plan predicted the
  archive would "wait the claim out and resolve `ok: true`" — it cannot: the
  claim only releases after the archive settles, so without the `lock_timeout`
  the archive blocks the release forever. The mutation is still caught, which
  is the point.

- Step 11 (comment out the `isTransientDbError` branch): FAIL as predicted.
  `PrismaClientUnknownRequestError: Invalid \`tx.classTemplate.updateMany()\`
  invocation ... Error occurred during query execution: ConnectorError(... 55P03,
  message: "canceling statement due to lock timeout" ...)` — the `55P03` is
  rethrown, so `await archiveOrUnarchiveTemplate` rejects and the test times
  out waiting for the release that never fires. The `afterEach` hook times out
  for the same reason.

## Task 2

- Step 10, mutation 1 (comment out `await setLockTimeout(tx);`): FAIL, same
  timeout shape as Task 1's mutation 1 — `Error: Test timed out in 20000ms.`
  with `Hook timed out in 10000ms.` The studio archive cannot settle, so the
  release never fires.

- Step 10, mutation 2 (comment out the `isTransientDbError` branch): FAIL as
  predicted — `PrismaClientUnknownRequestError` carrying
  `55P03 "canceling statement due to lock timeout"` is rethrown, the
  `await archiveOrUnarchiveStudioTemplate` rejects, and the test times out
  with `Hook timed out in 10000ms.`

## Task 3

Deviation from the plan, recorded before the task's own mutation records
(below), so the reviewer can see it with the failure it replaces. Adjudicated
by the issue author on 2026-08-14.

- The plan's original Task 3 test was built on an unreachable predicted
  failure. It paused the template (`isActive: false`) and then asserted
  `expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull()`,
  but the claim selects `WHERE "isActive" = true`, so it returned `null` and
  the test died at its own setup assertion — `AssertionError: expected null
  not to be null` at `src/services/class-generator.test.ts:456:74`, in
  ~134-192ms. The plan's predicted FAIL ("the resume waits the claim out and
  resolves `ok: true`") was unreachable: a resume only runs on a paused
  template (the `isActive === desiredActive` guard returns `unchanged`
  otherwise) and the claim only locks active templates, so the two sets are
  disjoint and a resume can never lose to the claim. Caught by the coding
  agent during the Step 1 verification run, flagged to the issue author for
  adjudication, and re-built as the PAUSE arm (active template, claim holds
  the row `FOR UPDATE`, `pauseOrResumeTemplate(..., 'paused')` blocks). The
  corrected test is in the plan and the source; the plan doc was amended in
  commit `e8a1c81`.

- Honest red for the corrected pause-arm test, pre-fix: `Error: Test timed
  out in 20000ms.` — the pause blocks on the claim with no `lock_timeout`
  bound, so it never settles and the release never fires (`Hook timed out in
  10000ms.`). Same shape as the Task 1 baseline, confirming the test passes
  only once the pause answers `busy` within the lock window.

- Both corrected tests (Task 3 and Task 4) restore the template to
  `isActive: true` after their assertions, as the issue author requested, so a
  mutation that ever lets the pause COMMIT can never leak a paused template
  into later tests in the file. Worth recording, honestly, that the three
  mutation runs below did NOT produce such a commit — in none of them does the
  pause win the row: with the bound removed it blocks forever (mutation 1,
  timeout), with the transient branch removed it rejects (mutation 2), and
  with the sentinel collapsed it still loses the race and rolls back
  (mutation 3). The restore is therefore a defensive guard here, not one the
  mutation runs exercised — kept because the issue author asked for it and the
  plan's original test carried it.

- Coverage gap, stated rather than dropped: the pause arm does NOT take the
  generation claim (only the resume arm does), so the corrected tests never
  exercise the claim re-issuing the same 2s bound partway through the
  transaction. Safe by `setLockTimeout`'s documented overwrite semantics but
  unproven — written into the Task 4 test docblock so it cannot be mistaken
  for tested.

Task's own mutation records (plan Step 9), recorded after implementation:

- Step 9, mutation 1 (comment out `await setLockTimeout(tx);`): FAIL, same
  timeout shape as the baseline. `Error: Test timed out in 20000ms.` on
  `answers busy when a pause loses the row to the generation claim`, with
  `Hook timed out in 10000ms.` The plan predicted "the resume succeeds" — it
  cannot: the claim holds the row until the release, the release only fires
  after the pause settles, and the transaction's 10s budget is only checked at
  statement boundaries, so a statement blocked on a lock never reaches one.
  The mutation is still caught, which is the point.

- Step 9, mutation 2 (comment out the `isTransientDbError` branch): FAIL —
  `PrismaClientUnknownRequestError: ... PostgresError { code: "55P03",
  message: "canceling statement due to lock timeout", severity: "ERROR" ...}`
  is rethrown from `pauseOrResumeTemplate` (the `await` at
  `src/services/class-template-lifecycle.ts:543`), the test rejects, and the
  `afterEach` hook times out in 10000ms because the claim still holds the row.

- Step 9, mutation 3 (change `return 'busy' as const` to `return null`): FAIL
  as predicted — `AssertionError: expected { ok: false, reason: 'not_found' }
  to deeply equal { ok: false, reason: 'busy' }` at line 473, in ~2.2s (the
  pause loses the race at the 2s bound, rolls back, and answers `not_found`).
  Proves the two sentinels are actually distinguished rather than collapsing
  into one answer.

## Task 4

- Step 9, mutation 1 (comment out `await setLockTimeout(tx);`): FAIL, same
  timeout shape as Task 3's mutation 1 — `Error: Test timed out in 20000ms.`
  on `answers busy when a studio pause loses the row to the generation
  claim`, with `Hook timed out in 10000ms.` The studio pause's CAS blocks on
  the claim with no bound, never settles, and the release never fires.

- Step 9, mutation 2 (comment out the `isTransientDbError` branch): FAIL —
  `PrismaClientUnknownRequestError: ... PostgresError { code: "55P03",
  message: "canceling statement due to lock timeout", severity: "ERROR" ...}`
  is rethrown from `pauseOrResumeStudioTemplate` (the `await` at
  `src/services/studio-class-template-lifecycle.ts:336`, on the CAS's
  `updateMany`), the test rejects, and the `afterEach` hook times out in
  10000ms. This is the exact shape the issue never named: the function had no
  `catch` at all, so this raw rejection is what used to reach the API
  wrapper.

## Review round 2

Five guards were added or restored after the multi-agent review. Each was
mutated, and each mutation is recorded with the exact text it produced, then
restored and re-verified.

- **The archive routes' new `switch (result.action)` + `never`.** Before the
  change, adding an `ok: true` arm to both archive unions compiled clean —
  that is what the review measured, and it is why the change exists. After:
  `src/app/api/class-templates/[id]/route.ts(219,15): error TS2322: Type
  '{ ok: true; action: "mutNewArm"; template: {...}; purged: number; }' is not
  assignable to type 'never'.` and the same at
  `src/app/api/studio-class-templates/[id]/route.ts(176,15)`. Two sites, two
  errors, restored clean.

- **The four `log.warn` lines.** Deleting only the class archive's call and
  keeping its `return` — which left every test green before this round — now
  fails: `AssertionError: expected "LOG" to be called with arguments:
  [ ObjectContaining{…}, …(1) ]` on `answers busy when the generation claim
  holds the row past the lock timeout`.

- **`{ timeout: 10_000 }` on the two class-family functions.** Deleting both
  literals now fails two tests, where before it failed none:
  `AssertionError: expected undefined to deeply equal { timeout: 10000 }` on
  both `opens the archive transaction with { timeout: 10_000 }` and `opens the
  pause/resume transaction with { timeout: 10_000 }`.

- **The route copy's archive/unarchive ternary.** Inverting it to
  `state === 'archived' ? 'unarchive' : 'archive'` in the studio route fails
  the new integration test: `AssertionError: expected 'The system was busy and
  could not arc…' to contain 'could not unarchive this recurring st…'`. Both
  limbs are grammatical English, so nothing else in either suite noticed.

- **`setLockTimeout` reaching past the CAS.** Commenting it out of
  `archiveOrUnarchiveTemplate` fails the new `deleteMany` test with
  `Error: Test timed out in 20000ms.` — the same shape Tasks 1-4 record, and
  for the same reason: the blocked statement never reaches the boundary where
  Prisma checks its budget, so nothing aborts it.

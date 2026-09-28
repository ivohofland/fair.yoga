# Sweep-proof waitlist fixtures (#687) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No integration fixture leaves a `waiting` `WaitlistEntry` where the app's `waitlist-reconciliation` job would act on it (promote or broadcast) before the test's assertions finish. Every fixed site proves it with a reconciliation tick forced inside the test.

**Architecture:** Test-only change. A small helper module in `tests/` runs the production tick (`runWaitlistReconciliationTick`) through `scopeSweep`, narrowed to the test's own class ids, and asserts that the tick *skipped* each class for a named reason. Fixtures are changed to one of four shapes the sweep leaves alone. The rule goes in `docs/test-database.md` §3.4, the section that already describes what integration fixtures share with the running app.

**Tech Stack:** vitest `integration` project, Prisma, the `tests/scoped-sweep.ts` client.

**Spec:** none. This change touches test fixtures only, and the issue's own direction A already fixes the design. The design is below, together with the premise corrections that a spec would have held.

## Premise, as measured (issue #687)

- **Holds:** the job runs locally every minute (`src/lib/scheduler.ts`, `intervalMs: 1 * MINUTE`). CI sets `CRON_SCHEDULER: 'off'` on all three app-running jobs (`.github/workflows/ci.yml`). `reconcileOne` (`src/services/waitlist-reconciliation.ts`) invokes `handleSpotFreed` on every `open`, uncancelled, not-`frozen` class that has a `waiting` entry and active registrations `< maxStudents`. In the claim window it skips a class whose broadcast still stands (`already_broadcast`).
- **Wider than stated.** `grep -rn "waitlistEntry\.\(create\|createMany\|upsert\|update\|updateMany\)" tests/integration | wc -l` returns 35 direct writes (4+4+7+3+13+2+2 across waitlist-display, invitations-api, waitlist-api, bookings-page, registrations-api, classes-api and account-api). 21 are sweep-reachable and 14 are not. 13 of the 21 would fail an assertion if a tick lands in their span, not only the 2 the issue names. Two more direct writes free a seat under a waiting entry (`registrations-api` ~L637, `invitations-api` ~L3366). `tests/e2e` has no direct waitlist writes. The per-site audit is `/private/tmp/…/scratchpad/audit-687.md` (not committed); its table is reproduced in the PR body.
- **Audit corrected:** it listed `waitlist-api` ~L118 (the `CLAIM_NOT_OPEN` 409 fixture) as needing a free seat. It does not. `claimSpot` checks the window **before** it checks for a full class (`src/services/waitlist.ts`, `wrong_window` precedes `class_full`), and the test's `registration.count` is scoped to `studentId`. It can be filled.
- **CI runs integration files in parallel** (`--file-parallelism`, #325, `docs/test-database.md` §2). A forced tick must therefore be **scoped** to the test's own classes. An unscoped tick in CI would act on other files' live fixtures.

## Design: four shapes the sweep leaves alone

| Shape | How | Tick skip reason | Use when |
|---|---|---|---|
| **FULL** | Fill `maxStudents` with active registrations *before* the `waiting` write: lower `maxStudents` so existing registrations fill it, or add filler students' registrations | `full` | the test needs a waiting row, not a free seat |
| **BROADCAST STANDING** | Date the class inside the claim window (`[start − 1h, start)`, placed against real time, as `waitlist-api.test.ts`'s claim fixtures do, with `minStudents: 0` because of auto-cancel) and set `spotBroadcastAt` to now | `already_broadcast` | the test needs a free seat AND a direct booking or claim, and a standing broadcast is a state production reaches |
| **NOT OPEN / FROZEN** | already the case (status not `open`, `cancelledAt` set, or start passed) | not a candidate | no change needed |
| **FREE SEAT, SHORTEST SPAN** | keep the class full until the statement *immediately* before the test's own `promoteNext`, then free the seat | none; residual | the test drives `promoteNext`, which needs a free seat in the auto-promote window, which is exactly the sweep's target. The residual span is one statement. It is stated at the site and in the PR body |

A sweep-reachable site whose reach **breaks nothing observable** (the claim-window broadcasts in `waitlist-api` and `invitations-api` ~L3366, and `waitlist-api` ~L537, which calls `promoteNext` and ignores the result) keeps its free seat. It gets a one-line comment naming the shape and linking `docs/test-database.md` §3.4. Every fixture that becomes FULL or BROADCAST STANDING gets a forced-tick assertion right after the fixture.

## Global Constraints

- Test-only. No file under `src/` changes.
- Never kill or restart `:3000`. Integration runs against this worktree's app (`pnpm run worktree:up`, `INTEGRATION_BASE_URL` read automatically). Fast loop: `pnpm exec vitest run --project integration tests/integration/<file>`.
- Comment Discipline (CLAUDE.md): a comment annotates the fixture it sits on. The rule about the sweep lives in `docs/test-database.md` §3.4, and sites link to it. No counts or site rosters in comments. No "this previously…" history.
- Stage exact paths only, never `git add -A`. Quote paths with parentheses.
- Filler rows must be torn down by the file's existing `afterAll` pattern (by id or by the file's email suffix). Mind `docs`/memory *Undefined Prisma filter deletes all*: never `deleteMany({ where: { id: undefinedVar } })`.
- Tests assert a registered code, never a literal `error.message` (CLAUDE.md, *Refusals carry a registered code*).

## Review Focus

1. A filled class changes a number the test asserts: a displayed count, a price, a `registration.count` scoped by class instead of by student. Expect the implementer to re-derive the assertion from the stored row, never to weaken it.
2. A BROADCAST STANDING move puts a class within an hour of real time. The auto-cancel sweep (`minStudents` above 0) and the slot-exclusion constraint (the file's other near-time fixtures) can then bite. Mirror `waitlist-api.test.ts`'s claim fixtures: `minStudents: 0`, `durationMinutes: 1`, distinct offsets.
3. The forced tick must be scoped. An unscoped tick passes locally and corrupts parallel files in CI.
4. A forced-tick assertion that cannot fail certifies nothing. Each task mutates one site back to its free-seat form and records the failure text.
5. A lock test (invitations ~L3808, account-api ~L612/~L901) must still observe its lock: its waiting entry still reaches the withdrawal or erasure, and the 503 still arrives.

---

### Task 1: Helper, docs rule, and the two named tests (classes-api, invitations-api)

**Files:**
- Create: `tests/waitlist-fixtures.ts`
- Modify: `docs/test-database.md` (§3.4)
- Modify: `tests/integration/classes-api.test.ts` (notice fixture ~L269-301; the "closes the waitlist when a teacher moves a class to in_progress" test ~L1031)
- Modify: `tests/integration/invitations-api.test.ts` (unlink-lock describe ~L3733-3810; promote tests ~L3203-3300)

**Interfaces — Produces:**

```ts
// tests/waitlist-fixtures.ts
import type { PrismaClient } from '@prisma/client';
import type { SkipReason } from '@/services/waitlist-reconciliation';

/** Runs the production reconciliation tick narrowed to `classIds` and
 * asserts it skipped every one of them for `reason`. */
export async function expectReconciliationSkips(
  prisma: PrismaClient,
  classIds: readonly string[],
  reason: SkipReason,
): Promise<void>;

/** Creates `count` students with an active (`registered`) registration on
 * `classId`. Emails are `${tag}-filler-${i}@test.local`. Returns their ids for
 * teardown. Deleting the students cascades their registrations. */
export async function fillSeats(
  prisma: PrismaClient,
  classId: string,
  count: number,
  tag: string,
): Promise<string[]>;
```

`expectReconciliationSkips` body:

```ts
const scoped = scopeSweep(prisma, { WaitlistEntry: { classId: { in: [...classIds] } } });
const summary = await runWaitlistReconciliationTick(scoped.db);
for (const classId of classIds) {
  expect(summary.skipped).toContainEqual({ classId, reason });
}
expect(summary.reconciledClassIds.filter((id) => classIds.includes(id))).toEqual([]);
```

`toContainEqual` on the class's own id is the presence check. A class that fell out of the candidate set (no waiting row) fails it rather than passing vacuously. Its docblock says what the helper asserts and when to call it: after the fixture, before the action.

- [ ] **Step 1: Write the helper** as above. It imports `scopeSweep` from `./scoped-sweep`, `runWaitlistReconciliationTick` from `@/services/waitlist-reconciliation`, and `expect` from `vitest`.
- [ ] **Step 2: Failing pin, classes-api notice fixture.** At the end of the file's `beforeAll`, after the direct `waiting` write, add `await expectReconciliationSkips(prisma, [noticeClassId], 'full');`. Run `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts`. Expected: FAIL. The tick invokes the class instead of skipping it (maxStudents 8, one registration). Record the failure text.
- [ ] **Step 3: Fix the fixture.** Create the notice class with `maxStudents: 1`: give `makeClass` an optional capacity parameter, used only here. The lock student's registration then fills it, and the `waiting` entry is a state `addToWaitlist` itself would accept. Rewrite the fixture comment so it states the class is full and says why the direct write remains (the route under test only reads the row, and no session is needed). Drop the "would refuse … not full" clause, which is no longer true. Re-run. Expected: PASS, including 'names the class in the cancellation notice it sends' with its `removed` assertion.
- [ ] **Step 4: classes-api ~L1031** ('closes the waitlist when a teacher moves a class to in_progress'). Apply FULL: lower the class to the minimum capacity and fill it with `fillSeats` before the `waiting` write. Then add `expectReconciliationSkips(…, 'full')` before the transition request. Check that the transition still succeeds with a registration present and that `expired` is still asserted. Tear the fillers down in the test's own cleanup.
- [ ] **Step 5: invitations-api unlink-lock describe (~L3808).** Add a filler: `fillSeats(prisma, lockClassId, 1, \`lock-${suffix}\`)` BEFORE the `waiting` write. `maxStudents` is 1. Then add `expectReconciliationSkips(prisma, [lockClassId], 'full')` at the end of `beforeAll`. Add the filler ids to `afterAll`, deleted by id and guarded against an unassigned id. Update the comment beside the entry: the class is full, so the entry is one `addToWaitlist` would write, and withdrawing it frees no seat. Both tests in the describe must still pass. The second test must still observe `'waiting'`… `'removed'` and the probe result the describe asserts.
- [ ] **Step 6: invitations-api promote tests (~L3218 and ~L3259).** Apply FREE SEAT, SHORTEST SPAN. `promoteClassId` has `maxStudents: 2` and no registrations.
  - ~L3218 already has the shortest span: the entry write, then `promoteNext`. Change no code there. Add one comment line at the entry write saying the free seat is required by `promoteNext`, and that the write sits directly before the call because a free seat in the auto-promote window is what the reconciliation sweep promotes (`docs/test-database.md` §3.4).
  - ~L3259 writes the entry, then makes an HTTP decline, then calls `promoteNext`. A tick in between promotes before the decline and reverses the test's older-act/newer-act order. At the start of the test, fill the class with `fillSeats(prisma, promoteClassId, 2, …)`. Write the entry. Assert `expectReconciliationSkips(prisma, [promoteClassId], 'full')`. Do the decline. Then delete the fillers in the statement directly before `promoteNext`, with the same one-line comment. Delete the filler students in the test's `finally` as well, guarded by the ids being assigned.
- [ ] **Step 7: Docs rule.** In `docs/test-database.md` §3.4, after the integration bullet, add a paragraph:

  > **The app's scheduler runs against these fixtures.** Locally the running app ticks `waitlist-reconciliation` every minute (CI sets `CRON_SCHEDULER=off`), and that job promotes or broadcasts on any `open`, uncancelled class that has not started and holds a `waiting` entry beside a free seat. A fixture that writes a `waiting` entry directly therefore builds one of: a **full** class (fill `maxStudents` before the write), a **claim-window class with a standing broadcast** (`spotBroadcastAt` set), a class that is **not open or has started**, or, where the test itself drives `promoteNext`, a seat freed in the statement immediately before that call. A site that keeps a reachable free seat because the sweep's action there changes nothing it asserts says so beside the fixture. `expectReconciliationSkips` (`tests/waitlist-fixtures.ts`) forces a tick scoped to the test's own classes and asserts they were skipped. Scoped because CI runs integration files in parallel. Re-derive the direct writes with `grep -rn "waitlistEntry\.\(create\|createMany\|upsert\|update\|updateMany\)" tests/integration`.

- [ ] **Step 8: Mutation record (acceptance, both named tests).** For each of the two named tests, revert only the fixture change, keeping the forced tick, and run the file. Expected: `expectReconciliationSkips` fails. Then also comment out the `expect` lines inside the helper temporarily, so the tick still runs but asserts nothing, and run again. Expected: the ORIGINAL assertion fails with the issue's text (`expected 'promoted' to be 'removed'` for classes-api; for invitations-api, the lock describe's `'waiting'`/`'removed'`/probe assertion). Record the exact output of all four runs in the task report. Restore, confirm `git status` shows only the intended edits, and re-run both files green.
- [ ] **Step 9: Commit.** Commit `tests/waitlist-fixtures.ts`, `docs/test-database.md` and both test files as `test(waitlist): fixtures queue only where the reconciliation sweep leaves the entry alone (#687)`.

### Task 2: registrations-api

**Files:** Modify `tests/integration/registrations-api.test.ts`.

**Interfaces — Consumes:** `expectReconciliationSkips`, `fillSeats` from `tests/waitlist-fixtures.ts` (Task 1).

Sites, per the audit. Line numbers are at `fb61333b`, so re-find them by content.
- `makeEntry` helper (~L905) in 'DELETE /api/waitlist/[id] — profile-presence authorization', called from ~911/922/930. Class max 1, 0 registrations. **FULL**: fill before the entry, and assert the skip where the entry is written. 'the class teacher can remove any entry' must still answer 200.
- 'answers leaving a queue already left as unchanged' (~L969 `mine`, ~L972 `theirs`). **FULL**. `expect(after.updatedAt).toEqual(renumbered.updatedAt)` must still hold.
- "booking directly resolves the caller's waiting waitlist entry" (~L631 entry and ~L637 `registration.updateMany → cancelled`). The test models a seat freed without the hook, then a direct booking. **BROADCAST STANDING**: place the class in the claim window, with `spotBroadcastAt` set when the seat frees. Rewrite the test's comment to describe that production state (a freed seat whose broadcast is out, booked directly by a waiting student) rather than "a crashed hook". Assert `already_broadcast` after the seat frees and before the POST. The POST must still answer 201 and the entry must read `claimed`.
- 'sends spot_taken to each waiting student and none to the booker' (~L2372). It already sets `spotBroadcastAt` by hand, but in the auto-promote window (2099), where production never holds a standing broadcast. **BROADCAST STANDING**: move the class into the claim window, and assert `already_broadcast` before the POST. The spot_taken counts, the booker's absence and `spotBroadcastAt === null` after must all still hold.

`makeClass(n)` in this file builds 2099 classes. Add a claim-window variant modeled on `waitlist-api.test.ts`'s claim fixtures: offset inside `[start − 1h, start)` from real time, `durationMinutes: 1`, `minStudents: 0`, offsets distinct from each other so `CalendarEntry_teacher_slot_excl` never refuses.

- [ ] Step 1: Add the forced-tick assertion at each site first, and run the file. Expected: FAIL at the free-seat sites. Record one failure text.
- [ ] Step 2: Apply the shapes above and re-run the file. Expected: all green.
- [ ] Step 3: Mutation: revert one FULL site's filler, run, and record the failure. Revert the claim-window move of ~L2372, run, and record the failure. Restore, and check `git status`.
- [ ] Step 4: Commit `test(registrations): queue waiting entries only on classes the reconciliation sweep skips (#687)`.

### Task 3: waitlist-api, waitlist-display, bookings-page

**Files:** Modify `tests/integration/waitlist-api.test.ts`, `tests/integration/waitlist-display.test.ts`, `tests/integration/bookings-page.test.ts`.

**Interfaces — Consumes:** Task 1's helpers.

- `waitlist-api` 409 fixture (~L118, `farFutureClassId`, max 2, 0 registrations). **FULL**: fill both seats with `fillSeats`. `claimSpot` refuses `wrong_window` before `class_full`, and the test's registration count is scoped to `studentId`. Assert `full`. The `CLAIM_NOT_OPEN` refusal, `entry.status === 'waiting'` and a count of 0 must still hold.
- `waitlist-api` claim-window fixtures (~L181, ~L225, ~L595, ~L842) and the roster `promoteNext` fixture (~L537). These keep their free seat, because a claim or a promotion needs one. Add a one-line comment at each class fixture: sweep-reachable, what the sweep does there (broadcast, or the same promotion the test performs), and that no assertion below depends on it, linking `docs/test-database.md` §3.4. ~L181 already has an equivalent note at ~L336; do not duplicate it, point at it or leave it.
- `waitlist-display` count fixture (~L294, `countClassId`, max 2, 0 registrations, one `waiting` among five statuses). **FULL**, then assert `full`. `'1 on waitlist'` must still hold. Re-derive any other asserted number from the stored rows.
- `waitlist-display` status loop (~L236, `open` iteration). The test passes even if the entry is promoted, for a reason it does not name. **FULL** for the open iteration only. The other iterations are not open.
- `bookings-page` 'waitlist section, viewer has not chosen a tier' (~L932). The class has `minStudents: 2`, `maxStudents: 5`, one `registered` and one `late_cancel`, and the entry is written before the registrations. Make it **FULL**. Either set `maxStudents` to the active count the fixture already builds, if the page still renders the range meaningfully (min ≤ max must hold), or add fillers up to `maxStudents`. Then re-derive the asserted count, range and price-line from the stored rows. The test's two properties must still bite: the anonymous branch for `tierSelectedAt: null`, and `late_cancel` excluded from the count. Assert `full` after the fixture.

- [ ] Step 1: Add the forced-tick assertions and run all three files. Expected: FAIL at the FULL sites. Record one text per file.
- [ ] Step 2: Apply the shapes and the comments, then re-run. Expected: green.
- [ ] Step 3: Mutation: revert one filled site per file, run, and record. Restore, and check `git status`.
- [ ] Step 4: Commit `test(waitlist): fill the classes display and claim fixtures queue on (#687)`.

### Task 4: account-api erasure fixtures and the invitations claim reversal

**Files:** Modify `tests/integration/account-api.test.ts`, and `tests/integration/invitations-api.test.ts` (~L3366, comment only).

- `account-api` ~L612 ('reports ERASURE_BUSY with retry advice when the erasure loses a lock race', max 8, 0 registrations) and ~L901 (the late-entry lock-set test, `lateClassId`, max 8, 0 registrations). **FULL**: create the class with `maxStudents: 1` and one filler before the `waiting` write, then assert `full`. The erasure must still hit its lock and answer 503 (`ERASURE_BUSY` code), the retry must still clean up, and the late-entry test's pre-lock and stray check must still see the entry. Tear the filler down by id.
- `invitations-api` ~L3366 ('joining the queue reverses a decline, and the later claim adds nothing to it'). Its `registration.update → cancelled` frees a claim-window seat that the claim then takes. The sweep can only broadcast there, and nothing asserts on `spot_available`. Add a one-line comment saying so, linking §3.4.

- [ ] Step 1: Add the forced-tick assertions and run `account-api`. Expected: FAIL. Record the text.
- [ ] Step 2: Apply FULL and re-run both files. Expected: green.
- [ ] Step 3: Mutation: revert one filler, run, and record. Restore, and check `git status`.
- [ ] Step 4: Commit `test(account): erasure lock fixtures queue on a full class (#687)`.

## After the tasks

Run the whole-branch review (4 tasks), one fix wave, and one scoped re-review. Then run `pnpm run verify` in this worktree, with `worktree:up` live. The PR body carries the census command, the 35 = 21 + 14 arithmetic, the per-site verdict table, the mutation records, the residual span named at the FREE SEAT, SHORTEST SPAN sites, and the audit correction for ~L118.

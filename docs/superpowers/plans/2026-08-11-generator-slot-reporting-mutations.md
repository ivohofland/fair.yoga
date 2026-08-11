# #164+#192 mutation ledger

Ten observations, one per guard, each watched to fail. Format follows
`2026-08-11-cancellation-notice-names-class-mutations.md`: apply, run, record
verbatim, `git checkout`, re-run green. The baseline the mutations were cut
against is the branch at `077ec72` plus one new test (row 6, below):
`class-generator.test.ts` 27/27 and `studio-class-generator.test.ts` 20/20.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 1 | `ON CONFLICT` backstop — silent variant | restore the per-date `create` + `catch (P2002) { continue }` loop in `class-generator.ts` | leaves isActive committed when the clash lands on the last free date | `AssertionError: expected false to be true` — the clash poisoned the transaction and the silent `COMMIT` rolled the `isActive` flip back (#164's exact defect) |
| 1b | `ON CONFLICT` backstop — loud variant | same mutation | still fills the other free date when the clash lands on the first | `PrismaClientUnknownRequestError … PostgresError { code: "25P02", message: "current transaction is aborted, commands ignored until end of transaction block" }` |
| 1c | `ON CONFLICT` backstop — single clause | drop `skipDuplicates: true` from `createManyAndReturn` | names a date lost to a concurrent insert as raced, not as filled | `PrismaClientKnownRequestError … Unique constraint failed on the fields: ('templateId','date')` |
| 2 | `slot_taken` clause (class) | delete the `onDate.some(...)` branch | skips only the slot a manually created class occupies, and still fills the rest | `AssertionError: expected 4 to be 3` |
| 3 | predicate mirror (class) | drop `&& c.status !== 'cancelled'` | does not treat a cancelled neighbour as occupying the slot | `AssertionError: expected 3 to be 4` |
| 4 | predicate mirror (studio) | drop `&& c.cancelledAt === null` | does not treat a cancelled neighbour as occupying the slot (studio) | `AssertionError: expected 3 to be 4` |
| 5 | `blocked_by_cancelled` | return `'already_generated'` for a cancelled own row, both generators | names a cancelled own instance as blocked_by_cancelled (both families) | `AssertionError: expected [ { … } ] to deep equally contain { Object (date, reason) }` — reason `"blocked_by_cancelled"` expected, `"already_generated"` received, both files |
| 6 | `raced` | delete the `landed` diff loop | names a date lost to a concurrent insert as raced, not as filled | `AssertionError: expected [] to deeply equal [ { …(2) } ]` — `created: 3` proves the colliding insert lost, `skipped: []` proves the diff never reported it |
| 7 | noise rule | drop the `s.reason !== 'already_generated'` filter in `logSkippedSlots` | logs blocked dates once per call, and stays silent for plain idempotency | `AssertionError: expected "LOG" to not be called at all, but actually been called 1 times` |
| 8 | `templateKind` | delete it from `StudioTemplateToggleResponse` | template-action-messages non-interchangeability describe | `error TS2578: Unused '@ts-expect-error' directive.` (the studio→class pin) |
| 9 | `slot_taken` clause (studio) | delete the studio `onDate.some(...)` branch | skips only the slot another studio class occupies | `AssertionError: expected 4 to be 3` |

## Mutation 1, both directions

Rows 1 and 1b are the whole issue. The silent variant (row 1) is what made
#164 user-visible rather than a debuggability nit: the resume reported success,
committed nothing, and left the template `isActive: false` without any error
anywhere. The loud variant (row 1b) is the same defect on a window with a
second free date: the next statement hits `25P02`, which is not P2002, so it is
rethrown past Resume's P2025-only `.catch`. Both were verified against the
unmutated code's green 27/27 first.

## What the plan's row 6 got wrong

The plan said deleting the `landed` diff loop would fail "Task 2's `skipped`
reason assertion". There is no such assertion: Task 2's two tests assert
`isActive` and row counts only, and nothing in the repo asserted `raced`. The
mutation was applied first and **passed the entire 26-test suite** — a guard
that compiles but cannot fail certifies nothing. A deterministic test pinning
`raced` was added instead (same holder-in-flight lever as the #164 resume
fixture: occupancy read runs while the holder's row is uncommitted, the
generator's insert parks on the pending unique entry and loses on commit).
Mutation 6 then failed it, and rows 1b/1c cross-pin the same test.

## Realism — what a plausible regression looks like

- **Row 1 is a wholesale restore** of the pre-#164 loop. Row 1c is the
  realistic single-clause regression (forgetting the flag), and the one a
  future reader is likelier to make.
- **Row 2 is a wholesale delete.** The realistic drift of that clause is
  narrowing it, which rows 3 and 4 are exactly the single-clause forms of.
  Row 9 is the studio twin of row 2.
- **Row 5's flip is itself the single-clause regression** (dropping the status
  condition), applied to both generators so #192's test fails in both families.
- **Row 7 is a wholesale filter removal**; the test's "stays silent" line pins
  the `already_generated` exclusion specifically.
- **Row 8 is the plan's predicted exact failure** — `templateKind`'s whole job
  is the `@ts-expect-error` pin, and deleting it from the studio type makes the
  directive unused, which `tsc --noEmit` reports.
- **Row 6's mutation is small by construction** (a two-statement diff loop);
  the guard it deletes is the only thing that can turn a lost race into a
  reason, which the new test now asserts directly.

## Housekeeping

- The new `raced` test uses a `templateId`-bearing holder row: a
  `templateId: null` row has a *different* unique key (`(NULL, date)` does not
  conflict with `(template.id, date)`), so the generator would insert right
  past it and `created` would be 4, not 3.
- Each mutation was reverted and its target file re-run green before the next
  one: `class-generator.test.ts` 27/27, `studio-class-generator.test.ts`
  20/20, `npm run typecheck` clean after row 8's revert.

---

## Round 2 — added after the five-agent PR review of #204

The review found four guards that could not fail. Three of them are mutations
this ledger claimed to cover and did not, because the *test* they were checked
against could not distinguish the mutated behaviour from the correct one. Each
row below was applied, watched to fail, reverted, and the target file re-run
green.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 10 | T1/T2 reproduce the race at all | commit the holder's row *before* the resume starts (`void released` in `raceResumeAgainst`) | both `a clash during generation (#164)` tests | `AssertionError: expected [] to deeply equal [ '2026-09-08' ]` and `[ '2026-09-01' ]` |
| 11 | resolver argument order, arguments 3 and 4 | swap `data.blockedByCancelled` and `data.slotTaken` at `resolveTemplateConfirmation`'s call site | `returns the class resume message for an active payload` | `AssertionError: expected '4 classes on your schedule. 2 dates a…' to be '…1 date al…'` |
| 12 | `blockedByCancelled`'s filter | `s.reason === 'blocked_by_cancelled'` → `'already_generated'` in `pauseOrResumeTemplate` | `counts cancelled dates separately from taken slots` | `AssertionError: expected { ok: true, action: 'active', …(5) } to match object { …(2) }` |
| 13 | occupancy scoping (class) | drop `teacherId` from `class.findMany`'s `where` | `ignores another teacher holding the same date and time` | `AssertionError: expected +0 to be 4` |
| 14 | occupancy scoping (studio) | drop `teacherId` from `studioClass.findMany`'s `where` | `ignores another teacher holding the same weekday and time` | `AssertionError: expected +0 to be 4` |
| 15 | `raced` (studio) | delete the studio `landed` diff loop | `names a date lost to a concurrent insert as raced, not as filled` | `AssertionError: expected [] to deeply equal [ { …(2) } ]` |

## What round 1 could not see, and why

**Row 10 is the important one.** Rows 1 and 1b were run against tests that
asserted only `isActive === true` and a row count of 4 — and both of those hold
in a world where the collision never raced, because the holder's row committed
first and the date simply read `already_generated`. The reviewer measured that
directly: with the row pre-committed, both tests passed. So rows 1 and 1b were
real (the race *did* reproduce when they ran) but **unrepeatable** — a slower
box, a warm-up delay, or one extra `await` in `pauseOrResumeTemplate` would have
turned them green and empty, and this ledger would have gone on claiming they
covered #164. The tests now assert the generator classified the date `raced`,
which is the only observable that separates the two worlds.

**Rows 13–15 were absent, not weak.** Round 1 mutated the class generator only,
so half of `raced` and both occupancy scopings had no row at all. The scoping
mutation is §4.1's "stricter than the index" direction, which the spec calls the
only real defect of the two — and it passed the entire suite in both families,
because `class-generator.test.ts` had one teacher in its fixture and the one
studio test with two teachers asserted nothing that a wrongly-blocked window
would break.

**Row 12 needed its arithmetic checked, not just its assertion.** The first
draft of that test cancelled two of four dates — so `blocked_by_cancelled` and
`already_generated` were both `2`, the mis-wired filter returned the right number
by coincidence, and the mutation passed. Three of four makes them `3` and `1`,
which cannot collide. A guard is only as strong as the arithmetic separating the
right answer from the wrong one.

## One guard deliberately left unpinned

The in-transaction `defaultTimezone` read at `class-template-lifecycle.ts:495`
(added by the review itself) has **no test**, and the reasoning is recorded
beside the code rather than hidden here: making the two reads disagree needs
both an injected zone change and a wall-clock hour at which the zones' local
days straddle a generated date. `pauseOrResumeTemplate` takes no injectable
clock, so the test would pass vacuously at most hours — #138's failure mode —
and adding a `now` parameter to production code for a test to steer is something
this project declines to do. Recorded as a known gap, not as coverage.

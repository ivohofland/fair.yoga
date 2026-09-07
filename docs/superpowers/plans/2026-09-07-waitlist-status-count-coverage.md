# Mixed-status waitlist coverage for the erasure diagnostics (#494)

## Premise, as measured

Issue #494 claims a mutation dropping the `status: 'waiting'` filter from
`deleteTeacherAccount`'s `waitingEntriesLeft` count (`src/services/gdpr.ts`)
survives the whole suite. **Confirmed by running it.** With the filter dropped
to `.count({ where: { classId } })`:

- `--project unit` — 86 files, 1395 tests, all passed.
- `--project unit-sweeps` — one failure, `src/lib/db-locks-lock-order.test.ts`,
  which cannot observe this mutation: its only references to gdpr are seven
  comment citations of a sibling file, no import and no call. Unmutated
  baseline of that tier is 27 files / 217 tests green, and the file passes on
  its own re-run. Lock-timing flake, not the mutation.
- No `integration` test can catch it either: `waitingEntriesLeft` appears
  nowhere under `tests/`.

The issue's line reference (`gdpr.ts:1513-1515`) and its reading of the
docblock are both accurate.

## What the issue did not cover

Sweeping the shape rather than the line gives four sites. Re-derive with:

```
grep -rn --include='*.ts' -B1 '\.count(' src | grep -v '\.test\.' | grep -i waitlist
```

Deliberately not a pattern over the filter's own text (`"status: 'waiting' } })"`).
That form matches one particular closing syntax, so it answers about
*formatting* rather than about call sites: a site split across lines, or one
writing `status` before `classId`, is invisible to it. It happens to return the
same four today, which is exactly why it is the wrong command to ship — it
would go on looking complete after a reformat. The command above walks
`.count(` call sites instead, and returns those four plus one comment hit in
`waitlist-retention.ts` that is a `db.class.count`, not a waitlist one.

Scope, to be precise about what "the shape" means here: counts whose only
consumer is a log field. The ~20 other `status: 'waiting'` filters in `src` are
behavioural — they decide who gets promoted or notified — so dropping one
breaks something a test already watches. A diagnostic count is the case where
nothing but an assertion on the log payload can see the filter at all.

| Site | Role | Filter provable today? | Verdict |
|---|---|---|---|
| `gdpr.ts:1514` | `deleteTeacherAccount` post-commit diagnostic | No | **Fix** — the issue's own subject |
| `gdpr.ts:882` | `deleteStudentAccount` spot-freed diagnostic | No, though a real-DB test exists | **Fix** — same shape, same file |
| `api/registrations/[id]/route.ts:481` | `promoteAfterCancel` diagnostic | Not there — `promote-after-cancel.test.ts` mocks the count (`waitlistCount.mockResolvedValue(3)`) | Decline: proving it needs a DB-tier test that does not exist, which is a design decision, not a leaf |
| `waitlist.ts:887` | suppressed-broadcast count | No | Let go: feeds only a `debug` line the module's own comment calls off-by-default |

`gdpr.ts:882` is folded in rather than filed because it is the identical shape
in the identical file — filing it would mean a future reviewer opens #495 for
what this branch already had open. It is not free, though: a student row, a
waitlist row, a field on the fixture's return shape, and two edits to the
shared `cleanup`.

## Task 1 — teacher erasure (the acceptance criterion)

In `describe('deleteTeacherAccount cancels by compare-and-swap (#174)')`, add a
test that stages a **mixed-status** waitlist on a class reaching the
post-commit diagnostic, via the block's established
`lockClassRowsOrdered`-injection pattern:

- `waitingStudentId` → `status: 'waiting'`
- `registeredStudentId` → a non-`waiting` status

Two distinct students because `WaitlistEntry` is unique on
`(classId, studentId)`. Assert `waitingEntriesLeft: 1`, not `2`.

Both rows survive to be counted: a skipped class `continue`s before the
waitlist sweep, which is the residual the diagnostic exists to report.

## Task 2 — student erasure (the swept sibling)

In `describe('student erasure is retry-safe against a concurrent duplicate
(#196)')`, extend the broadcast-failure path so the spot-freed diagnostic's
`waiting` field is asserted against a mixed-status queue.

**The fixture trap:** the non-`waiting` row must belong to a student the
erasure does not touch. Giving it to `fixture.studentId` would make
`deleteStudentAccount` delete it during erasure, leaving the count `1` whether
or not the filter is present — an assertion that passes for the wrong reason.
So: a third student, added to the shared `makeStudentWithFreedSpot` and reaped
by the shared `cleanup`. That puts the spent entry in front of both tests in
that describe, not only the broadcast one — harmless, because the sibling
asserts on `log.error`'s message and never reads the `waiting` value.

## Verification, per task

Not "the test passes" — the test must **fail** against the mutation it exists
to catch:

1. Run the new test against unmutated source. Expect PASS.
2. Drop that site's `status: 'waiting'` filter. Run again. Expect FAIL, with
   the received count exceeding the expected one. Record the exact message.
3. Restore. Re-run. Expect PASS.

Restore by editing the line back, not `git checkout` — the file carries the
other task's edits too.

## Out of scope

Both sites are correct today; neither is a live defect. This branch adds no
source change at all — `src/services/gdpr.ts` is untouched on merge.

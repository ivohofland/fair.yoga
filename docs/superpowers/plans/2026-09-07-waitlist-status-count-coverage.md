# Mixed-status waitlist coverage for the erasure diagnostics (#494)

## Premise, as measured

Issue #494 claims a mutation dropping the `status: 'waiting'` filter from
`deleteTeacherAccount`'s `waitingEntriesLeft` count (`src/services/gdpr.ts`)
survives the whole suite. **Confirmed by running it.** With the filter dropped
to `.count({ where: { classId } })`:

- `--project unit` — 86 files, 1395 tests, all passed.
- `--project unit-sweeps` — one failure, `db-locks-lock-order.test.ts`, which
  cannot observe this mutation: its only references to gdpr are seven comment
  citations of a sibling file, no import and no call. Unmutated baseline of
  that tier is 27 files / 217 tests green, and the file passes on its own
  re-run. Lock-timing flake, not the mutation.
- No `integration` test can catch it either: `waitingEntriesLeft` appears
  nowhere under `tests/`.

The issue's line reference (`gdpr.ts:1513-1515`) and its reading of the
docblock are both accurate.

## What the issue did not cover

Sweeping the shape rather than the line — `grep -rn --include='*.ts'
"status: 'waiting' } })" src | grep -v '\.test\.'` — gives four sites:

| Site | Role | Filter provable today? | Verdict |
|---|---|---|---|
| `gdpr.ts:1514` | `deleteTeacherAccount` post-commit diagnostic | No | **Fix** — the issue's own subject |
| `gdpr.ts:882` | `deleteStudentAccount` spot-freed diagnostic | No, though a real-DB test exists | **Fix** — same shape, same file |
| `api/registrations/[id]/route.ts:481` | `promoteAfterCancel` diagnostic | Not there — `promote-after-cancel.test.ts` mocks the count (`waitlistCount.mockResolvedValue(3)`) | Decline: proving it needs a DB-tier test that does not exist, which is a design decision, not a leaf |
| `waitlist.ts:887` | suppressed-broadcast count | No | Let go: feeds only a `debug` line the module's own comment calls off-by-default |

`gdpr.ts:882` is folded in rather than filed because it is the identical shape
in the identical file and costs one fixture row — filing it would mean a
future reviewer opens #495 for what this branch already had open.

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
So: a third student, created and reaped by the test itself.

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

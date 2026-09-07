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
grep -rn --include='*.ts' -A1 'waitlistEntry' src | grep -v '\.test\.' | grep '\.count('
```

It returns exactly the four rows tabled below, at the line numbers in that
table, and nothing else.

Deliberately not a pattern over the filter's own text (`"status: 'waiting' } })"`),
which is what this plan first shipped. That form matches one particular closing
syntax, so it answers about *formatting* rather than about call sites: a site
split across lines, or one writing `status` before `classId`, is invisible to
it. It happens to return the same four today, which is exactly why it was the
wrong command to ship — it would go on looking complete after a reformat.

The command above has an assumption of its own, and this plan is in no position
to leave it unstated: it needs `.count(` on the `waitlistEntry` line or the one
immediately after (`-A1`). A comment interposed between the receiver and the
call would hide a site from it. Better than keying on closing punctuation, not
immune.

Scope, to be precise about what "the shape" means here: counts whose only
consumer is a log field. The other 19 `status: 'waiting'` lines in non-test
`src` are behavioural — they scope a write, a lock set, a renumbering or a
notification set — so a dropped filter there changes what the system *does*,
not merely what it reports. A diagnostic count is the case where nothing but an
assertion on the log payload can see the filter at all.

**Whether tests actually catch those 19 was not measured**, and this plan will
not claim it. The argument for scoping them out is structural — their output
reaches a write rather than a log field — not a coverage result. Given that
all four sites this issue *did* measure turned out unprovable, assuming
coverage elsewhere is the one inference this issue is evidence against. If it
matters later, measure it; do not cite this paragraph.

That 19, with the command that re-derives it:
`grep -rn --include='*.ts' "status: 'waiting'" src | grep -v '\.test\.'` gives
28 hits, 5 of them inside comments, leaving 23 code lines; minus the 4
diagnostic counts tabled below = 19.

| Site | Role | Filter provable today? | Verdict |
|---|---|---|---|
| `gdpr.ts:1514` | `deleteTeacherAccount` post-commit diagnostic | No | **Fix** — the issue's own subject |
| `gdpr.ts:882` | `deleteStudentAccount` spot-freed diagnostic | No, though a real-DB test exists | **Fix** — same shape, same file |
| `api/registrations/[id]/route.ts:481` | `promoteAfterCancel` diagnostic | Not there — `promote-after-cancel.test.ts` mocks the count (`waitlistCount.mockReset().mockResolvedValue(3)`, line 131) | Decline: proving it needs a DB-tier test that does not exist, which is a design decision, not a leaf |
| `waitlist.ts:887` | suppressed-broadcast count | No | Let go: feeds only a `debug` line the module's own comment calls off-by-default |

`gdpr.ts:882` is folded in rather than filed because it is the identical shape
in the identical file — filing it would mean a future reviewer opening a
second issue for what this branch already had open. It is not free, though: a
student row, a waitlist row, a field on the fixture's return shape, and two
edits to the shared `cleanup`.

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

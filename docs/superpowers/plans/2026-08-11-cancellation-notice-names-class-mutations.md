# #200 mutation ledger

Four mutations, two per body: a wholesale revert, and a single dropped field.
The second is the realistic regression — an edit that trims the sentence — and
it is the one a whole-string equality assertion would have caught while a
`toContain('Hatha')` alone would not.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 1 | Teacher body names the class | revert to the pre-#200 text | auto-cancel teacher note | `AssertionError: expected 'Hatha was cancelled — only 0 of 4 min…' to contain 'Monday, 20 Jul'` |
| 2 | Teacher body carries the time | drop ` at ${fresh.startTime}` | auto-cancel teacher note | `AssertionError: expected 'Hatha class on Monday, 20 Jul was can…' to contain '18:00'` |
| 3 | Route body names the class | revert to the pre-#200 text | cancellation notice (integration) | `AssertionError: expected 'Classes API Notice has been cancelled…' to contain 'Monday, 1 Jun'` |
| 4 | Route body carries the time | drop ` at ${cls.startTime}` | cancellation notice (integration) | `AssertionError: expected 'Classes API Notice class on Monday, 1…' to contain '09:00'` |

Mutations 3 and 4 run against the app on :3000, so each needs a save-and-recompile
before the re-run — a mutation "passing" without one means the old bundle answered.
Both failed with the mutated source's own text in the `Received` line, which is the
evidence the recompile happened before the assertion ran.

## Round 2 — added after PR review

The test-coverage reviewer found two mutations that **passed**, and demonstrated
both rather than arguing them. Neither is a defect this PR introduced; both are
things the four mutations above could not see, because they only ever asked
whether the three interpolated fields were present.

| # | Guard | Mutation | Test that failed | Observed |
|---|---|---|---|---|
| 5 | The route notifies waiting students, not only registered ones | `[...registrations, ...waiting]` → `[...registrations]` | cancellation notice (integration) | `NotFoundError: No Notification found` on the waitlisted recipient |
| 6 | The student sentence stays distinct from the teacher's | replace the student body with the teacher's sentence | cancellation notice (integration) | `expected 'Classes API Notice class on Monday, 1…' to contain 'has been cancelled by your teacher'` |

**Before round 2, mutation 5 passed the entire integration project — 27 files,
348 tests.** The route fans out to `[...registrations, ...waiting]` and nothing
in the repo exercised the waiting half; `full-flow.test.ts` reaches
`transitionClass` as a service and never this route's cancel branch. Dropping
`...waiting` silently stops telling queued students their class was cancelled —
#112's defect, in the one path #112 used as its reference implementation.

**Mutation 6 passed 21/21.** Asserting three interpolated fields says nothing
about the sentence carrying them, so the student body could be swapped for the
teacher's and every manually-cancelled student would be told a false reason
("only 0 of 1 minimum students registered"). The teacher body was already
pinned distinct by its "only N of M" clause; the student body was not. The
asymmetry was the tell.

Both now fail. Round 1's four still fail. The lesson worth keeping: **an
assertion that a field is present is not an assertion that the sentence is
right**, and a fan-out is not covered until each arm has its own recipient.

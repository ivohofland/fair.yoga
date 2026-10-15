# Ceiling tests analyze their seed (#891) — plan

**Goal.** `src/services/sweep-page-ceiling.test.ts` stops timing out in CI's
`unit-sweeps` step. The cause has been measured rather than inferred (method
and numbers in `docs/test-database.md` §7 and the PR body), and the fix is
the one that cause calls for, not a longer timeout.

**Premise check.** The issue reads the failure as a one-off stall in
`readDuePayments`, and its first candidate is a bad plan on freshly
`createMany`'d rows. Measured:

- It is not one test. The same file failed the same way in runs 38164592733
  (`readDuePayments`, 5 s test timeout) and 38365523733 (`reconcileWaitlists`,
  5 s test timeout and then a 10 s hook timeout). About 50 s later in that
  run, `waitlist-position-migration.test.ts` timed out on its table lock too.
- It is not a lock wait. A watchdog on the ceiling clients, run as 40
  sweep-tier passes on CI runners, caught one stall: the `reconcileWaitlists`
  candidate `groupBy` had been `state = active` with no wait event for 20+ s.
  The backend was computing the whole time.
- It is a plan chosen from statistics older than the seed. Locally, with
  statistics from before the seed, that query runs as a nested loop that
  re-scans live `CalendarEntry` rows for each of the 1000 waitlist rows:
  500,500 rows removed by the join filter, 974 ms. After `ANALYZE` the same
  query runs as hash joins in 3.4 ms. The issue's candidate was right in kind.

**Direction.** Refresh planner statistics after each ceiling seed. Rejected:
raising the timeout, which hides a 20 s plan; analyzing a per-describe table
list, which a future describe that seeds a new table would silently miss.
Whole-database `ANALYZE` has no list to drift, and the test database is small.

## Task 1 — `analyzeSeed`, called at the end of every ceiling `beforeAll`

- `tests/stack-ceiling.ts`: export `analyzeSeed(db)`, which runs a
  whole-database `ANALYZE`. Its docblock says when to call it and links §7.
- `src/services/sweep-page-ceiling.test.ts`: every `beforeAll` ends with
  `await analyzeSeed(prisma)`, after its last write.
- Verify: the ceiling file passes locally. On CI, with the call skipped and
  with it in place, compare per-test duration distributions across repeated
  sweep-tier passes (temporary diagnostic workflow, dropped before the PR).
- Prove it bites: with the call skipped, the stale arm must show the long
  tail (or a failure). With it in place, the tail must be gone.

## Task 2 — `docs/test-database.md` §7

Record the mechanism with its measured numbers, so the next test that
bulk-seeds and then runs a database-wide read knows to analyze, and why a
timeout bump is the wrong fix. The numbers live there, with the method that
re-derives them, not in a docblock.

## Order

Task 1 before Task 2: §7 quotes the CI arms' measurements.

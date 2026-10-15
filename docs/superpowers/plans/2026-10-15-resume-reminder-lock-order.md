# Payout resume reminder lock order (#883) — plan

**Spec:** `docs/superpowers/specs/2026-10-15-resume-reminder-lock-order-design.md`

**Goal:** `resumePayments` takes its reminders' `FOR KEY SHARE` locks on `Class`
in ascending id, so it cannot close a cycle with `deleteStudentAccount`'s
ordered `FOR UPDATE` pre-lock; a lock-order test stages the cycle.

## Global Constraints

- TypeScript strict; no `any`. Match the surrounding test file's idiom
  (`latch`, `ownPid`, `waiterOf`, `PrismaClient` per connection,
  `uniqueSuffix`).
- The test lives in `src/services/payout-resume-lock-order.test.ts`, which is
  already in `SERIAL_TESTS` (`vitest.tiers.ts`). Update that file's header
  docblock so it describes both cases it now holds.
- Comment Discipline (CLAUDE.md): comments annotate the code they sit on; no
  counts or rosters in comments; no "this previously read X".
- The ordering must be a Postgres `ORDER BY` (Prisma `orderBy`), not a JS sort
  — see the spec for why.
- Run in the worktree `/Users/ivohofland/Projects/fair.yoga-883`. Put Node 24
  first on `PATH` (`$HOME/.nvm/versions/node/v24.21.0/bin`). The test DB is the
  worktree's own (`.env`); `pnpm exec vitest run --project unit-sweeps
  src/services/payout-resume-lock-order.test.ts` runs the file.
- Stage exact paths; never `git add -A`/`git add .`. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Task 1 — The test, then the ordering (order is load-bearing: test first)

**Files:** `src/services/payout-resume-lock-order.test.ts`,
`src/services/payout-resume.ts`.

**Test (write first, see it fail):** a new `describe` in the existing file —
"resumePayments against a student erasure on two completed classes" — one
case, staged with the real `deleteStudentAccount` (`./gdpr`) and
`resumePayments`:

1. Fixtures: a teacher, paused (`paymentsPausedAt`, `pauseWindowStart` in the
   past, as the existing case), with a session and no passkey, so the passkey
   gate is not required; its fingerprint from `payoutFingerprint`. A student
   (with its own account, so the erasure's account branch runs as in
   production). Two classes of that teacher, `status: 'completed'`, built
   with `createClassFixture` (`tests/class-fixtures.ts`) — read it for its
   options; use distinct slots so the teacher-slot exclusion constraint is not
   hit. Per class: a `Registration` for the student, a `Payment` with
   `status: 'pending'` and the class's currency, and a `WaitlistEntry` with
   `status: 'claimed'`. Read `prisma/schema.prisma` for the required columns.
2. Name `lo`/`hi` by Postgres order:
   `SELECT id FROM "Class" WHERE id IN (a, b) ORDER BY id` — not a JS
   comparison.
3. Connection C (`new PrismaClient()`) opens a transaction and holds
   `SELECT id FROM "Class" WHERE id = hi FOR NO KEY UPDATE` until released.
   `FOR NO KEY UPDATE` conflicts with the erasure's `FOR UPDATE` but not with
   a `FOR KEY SHARE`, which is what lets the unordered resume take `hi`.
4. Start `deleteStudentAccount(prisma, studentId)`; wait (poll
   `pg_blocking_pids`, as `waiterOf` does) until a backend is blocked by C's
   pid. That backend is the erasure, now holding `lo` `FOR UPDATE`; record its
   pid.
5. Start `resumePayments(prisma2, …)` on a SEPARATE `PrismaClient` (the
   erasure's interactive transaction holds one of `prisma`'s pool connections;
   a second client makes the two independent). Wait until a backend is blocked
   by the erasure's pid.
6. Release C and join it. Then await both. Assert the erasure resolves (use
   `expectErased` from `tests/erasure-assertions.ts` if it fits its contract —
   read it) and the resume returns `{ status: 'resumed' }`. Assert both
   "blocked" waits were observed, so the test proves it reached the staged
   shape rather than racing past it.
7. Clean up every row the case created, in the existing `afterAll` style;
   `joinOrThrow` (`tests/lock-order-teardown.ts`) for joining settled
   promises if it fits. Mind the erasure's 2s `lock_timeout`
   (`LOCK_TIMEOUT_SQL`, `src/lib/db-locks.ts`): steps 4–6 must release C well
   inside it; the polling helper's bounded wait is fine.

Do not assert anything about the reminder the resume writes for the erased
student — that residual is accepted (spec, "The residual this does not
change"), not pinned.

**Run it RED** against current `payout-resume.ts` and record the exact failure
text (expected: a Prisma error carrying `40P01` / "deadlock detected" from one
side). The unordered read's order is the planner's; if the no-`orderBy` run
happens not to deadlock, record that and rely on the deterministic mutation
below for RED.

**Implement:** in `resumePayments`, add
`orderBy: { registration: { classId: 'asc' } }` to the owed-payment
`findMany`, with a short comment on it saying why the order matters (the
reminders' `relatedClassId` FK locks follow this order; ascending matches the
ordered `FOR UPDATE` lockers) and linking `docs/lock-order.md` by section
name — the doc passage is updated in Task 2 and keeps its name; use the
link text "`docs/lock-order.md`, the fourth path", which targets the
existing "fourth path" passage.

**GREEN**, then **prove the guard bites**, recording the exact error text for
each and restoring after:
- mutation A: `classId: 'desc'` — must fail (deadlock);
- mutation B: remove the `orderBy` — record whether it fails.
Re-run GREEN after restoring. Run the file three times in a row GREEN to show
it is not flaky.

**Commits:** one `test:` commit for the failing test is not required — commit
the test and fix together as `fix: the payout resume locks its reminders'
classes in ascending order` with the RED/mutation evidence in the report, not
the commit body.

## Task 2 — `docs/lock-order.md` states the ordering

**Files:** `docs/lock-order.md` only.

Four places describe the resume's reminder inserts; each states the order
after this change:

1. The "fourth path" passage (`deleteTeacherAccount`'s named exception, then
   "`resumePayments` (`payout-resume.ts`) does too, and with no order — see
   its row below."): replace with a sentence saying it does so in ascending
   class id, see its row and the paragraph below.
2. The notification-site table row for `resumePayments`: keep "**many**" and
   add "in ascending class id (the owed-payment read's `orderBy`)".
3. The bold paragraph "**`resumePayments` takes `FOR KEY SHARE` on many
   classes in no order.**": rewrite as the rule the ordering keeps — the
   inserts take `FOR KEY SHARE` in the order the owed payments were read,
   which is ascending class id, the direction of every ordered `FOR UPDATE`
   locker; its classes are completed, which leaves `deleteStudentAccount`'s
   pre-lock (any `WaitlistEntry` status) as the one ordered locker it meets;
   two ascending lockers cannot cycle through that set. Pinned by
   `src/services/payout-resume-lock-order.test.ts`, which holds the higher
   class on a third connection so the erasure stops between its two locks,
   parks the resume behind it, and asserts both complete; with the read
   ordered descending it fails `40P01` (quote the exact text Task 1 recorded,
   from `<workspace>/task-1-report.md` — path given in the dispatch). Then one
   or two sentences naming the residual (the resume may write its reminder
   after the erasure commits, the same accepted residual as an announcement
   send — link that paragraph by its bold lead "A send that read before the
   erasure and commits after the scrub writes the id back"). State what is
   true now; no "previously", no "Reasoned, not pinned".
4. The resume bullet in the `Teacher`-row section ("The resume
   (`resumePayments` …"): "and `Notification` inserts, each of whose
   foreign-key check takes `FOR KEY SHARE` on its `Class`" gains "in
   ascending class id", and the sentence about the test names both cases.

Then `grep -n "no order" docs/lock-order.md` and give every hit a verdict.
Commit as `docs: lock-order.md states the resume's ascending class order`.

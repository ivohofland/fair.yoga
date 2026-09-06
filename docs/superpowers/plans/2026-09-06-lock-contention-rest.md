# Plan — the seven parallel-tier files that still stage lock contention (#468)

Spec: `docs/superpowers/specs/2026-09-06-lock-contention-rest-design.md`.
Read §3 (the per-file adjudication) and §4 (hazards) before starting a task;
each task below names the parts of them it owns.

Seven tasks. **Order is load-bearing**: task 1 proves the tier plumbing on the
cheapest possible change before four extractions rely on it, tasks 2–5 are
independent of each other but each leaves the suite green on its own, task 6
cannot run until every new filename exists, and task 7 measures the finished
state.

Two files get no task at all — `src/lib/api-errors.test.ts` and
`src/lib/db-locks.test.ts` stay whole (spec §3.1, §3.2). Their verdicts are the
deliverable; there is no edit.

## Conventions every extraction task follows

- **The new file carries `@serial-tier lock-contention` as the first thing in
  its own header docblock**, followed by the reason *that file* cannot share a
  parallel tier — written for that file, never copied from a sibling. Then a
  paragraph saying what was split out of what, and why (spec §2.1: the reason
  is that the source file is actively grown and a listed file makes the serial
  tier the default home for everything added to it later — **not** a cost
  argument, which the measurements do not support here).
- **The path goes on `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`**, in the
  same edit. `src/lib/serial-tier-membership.test.ts` fails if the marker and
  the list disagree in either direction.
- **Fixtures are duplicated, not shared.** The new file mints its own teacher,
  room and templates under its own suffix prefix, and its `afterAll` sweeps by
  its own `teacherId` only (spec H7).
- **No test's behaviour changes.** A moved test's body changes only where a
  name it closed over has to be rebound to the new file's fixture. If a moved
  test needs a different value to pass, stop and report it rather than adjusting
  the assertion.
- **Leave nothing orphaned** (spec H6): imports whose last runtime use left,
  local helpers only the moved tests called, `beforeEach`/`afterEach` hooks
  whose describe is now empty, and the describe itself if it is. `npm run lint`
  catches unused imports and nothing else on that list.
- **Verification per task**, from the worktree: `npm run typecheck`,
  `npm run lint`, then `npx vitest run --project unit --project unit-sweeps`.
  Integration and e2e cannot run here (no app on `:3000`); CI is the signal for
  those.

## Task 1 — `transition-class-lock-order.test.ts` joins the serial tier

**Files:** `src/services/transition-class-lock-order.test.ts`,
`vitest.tiers.ts`.

The file already is what the four extractions will build: one test, holding a
`Class` row through `lockClassRow` while `transitionClass` parks on it. It is
missing only the marker and the list entry (spec §3.7).

1. Add `@serial-tier lock-contention` to the top of the file's existing header
   docblock, with its own reason. The reason is in the file already, in its
   "WHY THE REASON, NEVER THE BOOLEAN" paragraph: the transition is itself
   bounded at 2 s, so a tier-mate's noise that delays the `pg_stat_activity`
   handshake past that bound turns `reason: 'CANCELLED'` into a `55P03` and the
   assertion fails from the wrong cause. Say that; do not restate the whole
   paragraph.
2. Add `'src/services/transition-class-lock-order.test.ts'` to
   `LOCK_CONTENTION_TESTS`, with a one-line note that it needed no extraction
   because the file was already the sibling.

**Prove the tether bites** (spec §6.2, CLAUDE.md *Comment Discipline*): with
both edits in place, delete the list entry and run
`npx vitest run --project unit src/lib/serial-tier-membership.test.ts`; record
the exact failure text, restore, re-run green. Then do the same by deleting the
marker instead. Two mutations, two recorded failures — the test asserts both
directions and only one of them is exercised by a single mutation.

**Green:** `npx vitest run --project unit --project unit-sweeps` passes, and
`npx vitest list --project unit-sweeps src/services/transition-class-lock-order.test.ts`
reports 1 test where `--project unit` now reports 0.

## Task 2 — `room-archive.test.ts`: one case appends to the existing sibling

**Files:** `src/services/room-archive.test.ts`,
`src/services/room-archive-lock-order.test.ts`. No `vitest.tiers.ts` edit —
the destination is already listed.

Move `answers busy when the archive already holds the child row` (spec §3.5)
out of `setTeacherRoomArchived — the mid-request resume race (issue 272)` and
into `room-archive-lock-order.test.ts`. Its describe keeps its other case
(`answers in_use rather than throwing when the constraint refuses the archive`),
which stages nothing, so the describe stays.

Both files use `fixtureRun` from `tests/room-fixtures.ts` with distinct
prefixes (`ra-` and `ral-`); the moved test builds its fixture through the
destination file's own `fx`, so its rows land in that file's namespace and its
cleanup sweeps them.

**Then rewrite the destination header** (spec H2). Its paragraph headed "WHAT
THE SIBLING FILE'S RACE CASE DOES NOT COVER" names this exact case as living in
the other file and argues from that. The distinction it draws — that case holds
the child by hand and watches a *resume* lose, saying nothing about what the
archive itself does, while this file's two cases put the archive on the waiting
side — is still true and still worth keeping. Replace the sentence, do not
annotate it, and do not leave a "this previously read…" trace (CLAUDE.md); the
before-and-after goes in the PR body.

Check the rest of that header while you are in it: it also says "Both cases
below hold a real row lock for about two seconds" and "Both assert on elapsed
time". With a third case present, both sentences need re-reading — the new
arrival holds for about two seconds but does **not** assert on elapsed time.

**Green:** both files pass alone and in the two tiers; `vitest list` reports 18
for `room-archive.test.ts` and 5 for `room-archive-lock-order.test.ts`.

## Task 3 — `class-lifecycle.test.ts` → `class-lifecycle-lock-order.test.ts`

**Files:** `src/services/class-lifecycle.test.ts`,
`src/services/class-lifecycle-lock-order.test.ts` (new),
`src/services/class-lifecycle-tier-guard.test.ts`, `vitest.tiers.ts`.

Move the two tests in spec §3.4, both from the `completeClass (DB)` describe:

- `decides from the class row the holder left behind, not from a read taken
  before the wait`
- `gives up on the 2s bound when another transaction holds the class row`

The first needs a class with one *charged* registration — its own docblock says
why, and that reason travels with it. The second needs only a class.

**The new file's header must explain why `class-lifecycle.test.ts` now has two
serial siblings** (spec §2): `class-lifecycle-tier-guard.test.ts` is serial for
DDL taking ACCESS EXCLUSIVE on `Registration`, a different mechanism, and its
name is about the tier guard rather than lock order. Say so in one paragraph so
the next reader does not merge them.

**Then delete the prose count** (spec H1). `class-lifecycle-tier-guard.test.ts`
says its split lets the list hold it "without serialising the other 81 cases in
`class-lifecycle.test.ts`". CLAUDE.md forbids a prose count in a comment
outright, so this is **deleted, not corrected to 79**. The load-bearing half —
that the rest of `class-lifecycle.test.ts` has no DDL in it and is fine in
parallel — survives without a number.

**Then re-point the moved docblock's own citation.** The second test's docblock
says its bounds are loose "as this repo's sibling lock-timeout tests are
(`class-generator.test.ts`)". After task 5 those siblings are in
`class-generator-lock-order.test.ts`. Task 6 owns the sweep; this task may
leave it and let task 6 catch it, but must not silently rewrite it to something
task 5 then contradicts.

**Green:** `vitest list` reports 79 and 2.

## Task 4 — `studio-class-template-lifecycle.test.ts` → its `-lock-order` sibling

**Files:** `src/services/studio-class-template-lifecycle.test.ts`,
`src/services/studio-class-template-lifecycle-lock-order.test.ts` (new),
`vitest.tiers.ts`.

Move the four tests in spec §3.6, drawn from three different describes:

- `two concurrent archives: the loser records nothing over the winner`
  (`archiveOrUnarchiveStudioTemplate (DB)`)
- `a concurrent archive mid-resume is reported as archived, not thrown`
  (`pauseOrResumeStudioTemplate (DB)`)
- `a concurrent archive mid-pause is reported as unchanged, not archived`
  (same)
- `returns busy when another transaction holds the row past the lock timeout,
  and logs it` (`updateStudioClassTemplate (DB)`)

Each source describe keeps other tests, so none of the three describes goes
away; the new file recreates whichever describe structure keeps each moved
test's context legible.

**`the residual CAS miss answers busy rather than throwing` STAYS** and is the
test most likely to be swept up by mistake: it is in the same describe as two
movers, it is about a `busy` answer, and it interposes through `$extends`. It
holds nothing for a duration and nothing queues behind it — "a different table,
so no wait", as its own comment says. `docs/lock-order.md` cites it by name
twice, including a `git log -S` command; if it moves, those break.

**Watch the slot counter** (spec H5). This file allocates `ScheduleRule` slots
from a running counter, and `ScheduleRule_teacher_slot_excl` refuses an overlap.
The new file allocates its own teacher and its own counter; each moved test
keeps the spacing of the block it came from. A wrong copy fails at fixture
build with a constraint name that says nothing about locks.

**Green:** `vitest list` reports 46 and 4.

## Task 5 — `class-generator.test.ts` → its `-lock-order` sibling

The largest task. **Files:** `src/services/class-generator.test.ts`,
`src/services/class-generator-lock-order.test.ts` (new), `vitest.tiers.ts`.

Move the twelve tests in spec §3.3. Four whole describes go across intact:

- `generateClassInstances — archive mid-sweep` (1 test, plus its `afterEach`)
- `generateClassInstances — edit mid-sweep` (1 test, plus its `afterEach`)
- `pauseOrResumeTemplate — a clash during generation (#164)` (3 tests, plus its
  `beforeEach`/`afterEach`, the `candidates`/`classRow` helpers, `HELD_FOR_MS`
  and the `raceResumeAgainst` helper — all of which exist only for these three)
- `archiveOrUnarchiveTemplate — the bound reaches its pre-lock` (1 test, plus
  the long describe-level docblock, which is about the moving case)

Four tests come out of `claimTemplateForGeneration`, which keeps its other
cases and therefore keeps its `beforeAll`/`afterEach` in both files:

- `makes a concurrent archive wait until the claim transaction commits`
- `answers busy when the generation claim holds the row past the lock timeout`
- `answers busy when a pause loses the row to the generation claim`
- `answers busy when the generation claim holds the row past the lock timeout
  (template edit)`

Two come out of `generateInstancesForTemplate — slot reporting`, which keeps
twelve others:

- `names a date lost to a concurrent insert by what still holds it`
- `names a short date nothing live overlaps as raced`

The destination needs the source file's top-level fixture — one teacher, one
room, one `TeacherRoom`, one template and its `ScheduleRule` — rebuilt under its
own suffix, plus whichever per-describe helpers the moved tests call
(`freshTemplate`, `candidates`, `classRow`).

**The `claimTemplateForGeneration` `afterEach` restores three columns it
captured in `beforeAll`.** Two of the four moving tests commit real edits
through `updateClassTemplate` and `pauseOrResumeTemplate`, which is what that
restore exists for. Both files need it; neither can drop it.

**Check `vi`/`log` in the source file after the move.** Three of the seven
`vi.spyOn(log, 'warn')` sites belong to moving tests and one to
`raceResumeAgainst`; three belong to tests that stay, so the imports stay. This
is the opposite of the usual outcome and is stated so nobody deletes them.

**Green:** `vitest list` reports 34 and 12, and the new file passes run alone.

## Task 6 — the citation sweep, and the two tier notes

**Files:** the eight citation sites in spec H3/H3a, `vitest.tiers.ts`,
`vitest.config.ts`. Runs only after tasks 1–5, because every re-point needs a
filename that does not exist until then.

**Re-derive the sweep rather than trusting the spec's list.** Two passes, both
run from the repo root:

1. By title — the nineteen moved test titles as a fixed-string list, over
   `*.ts`, `*.tsx` and `*.md`, excluding `node_modules` and
   `docs/superpowers/` (records; they state what was true when written).
2. By filename — the four source filenames and the four new ones, same roots
   plus `docs/`, per `docs/comment-citation-sweep.md`.

**Give every hit a verdict, and expect legitimate survivors.** The sweep's own
false positives are named in spec H4 and must be left alone:
`studio-class-generator.test.ts` holds same-titled studio twins of five movers,
and `waitlist-lock-order.test.ts` holds three tests titled `gives up on the 2s
bound when another transaction holds the class row`. Neither is a citation.
Likewise every "the 2s value is pinned by `db-locks.test.ts`" — that file stays
whole.

Known sites, from spec H3 (the sweep must find at least these; a sweep that
finds fewer is wrong):

- `src/services/entry-generation.ts`
- `src/services/studio-class-generator.test.ts`
- `tests/integration/class-templates-api.test.ts`
- `src/services/rule-lifecycle.ts`, two sites
- `src/services/template-lock-order.test.ts`, two sites — the second is H3a,
  a citation naming a test title that exists nowhere in the repo. Re-point it
  to the real title (`answers busy when a held class row outlives the lock
  timeout`) and its new file.
- `src/services/class-lifecycle-lock-order.test.ts` — the docblock task 3
  carried over
- `docs/lock-order.md` — the "independently proven necessary in …" file list.
  Its two other `studio-class-template-lifecycle.test.ts` citations name a test
  that stays; leave them and the `git log -S` command beside them.

**Then the two tier notes** (spec §6.5). `vitest.tiers.ts` has two paragraphs
that this change falsifies:

- "NOT a complete census of files that hold locks. `room-archive.test.ts` still
  holds one in `unit` — a `ClassTemplate` `FOR UPDATE` kept until the resume
  answers, under a 6s ceiling." That case is now in the serial sibling.
- "Nor is the parallel tier free of files that assert on how a staged race comes
  out while holding a lock of their own. #459 closed the files it targets into
  the siblings below; issue #468 owns what remains, with the candidate list and
  the measurement — a roster here would be a second copy of it."

Replace both with what is true afterwards. Spec §5 states it: after this change
the sweep's nineteen hits are eleven serial members plus three adjudicated
parallel-tier files, two of them comment-only and one (`db-locks.test.ts`) a
real lock-holder that was measured and kept. State that the property is
finished and where the adjudication lives; do **not** roster the three by name
here (CLAUDE.md — a roster of other files has no owner in this file), and do
not leave the note pointing at an open issue.

`vitest.config.ts`'s `unit` project comment says "Not every file here is free
of long lock holds, though — `vitest.tiers.ts` says so beside the list, and
#468 owns which files those are". It must move with the note it points at.

## Task 7 — measure both tiers, and close the spec

**Files:** `docs/superpowers/specs/2026-09-06-lock-contention-rest-design.md`.

Run each tier on its own, on the finished branch, the same way the baseline was
taken:

```
npx vitest run --project unit
npx vitest run --project unit-sweeps
```

Record duration, file count and test count for each, and the combined figure,
against the baseline in spec §6 (`unit` 17.48 s / 86 files / 1363 tests;
`unit-sweeps` 100.24 s / 21 files / 195 tests; combined 117.72 s, on
`0c0f43b7`). Report both tiers and the combination, with percentages —
`.github/workflows/ci.yml`'s `test-unit` job runs both on one critical path, so
the serial number alone is a half-truth.

Then reconcile the prediction: spec §6 predicts about +24 s on the serial tier
and a shrunken parallel tier. If the measurement disagrees, the measurement
wins and the spec says so — replace the prediction with the number and one
sentence about why it differed. Re-derive the §3.8 test counts with
`vitest list` at the same time and fix any that moved.

## Whole-branch review

After task 7, before the PR: one review over the whole branch on the most
capable model, then one fix wave, then one scoped re-review. What only a
whole-branch reader can catch here:

- a header reason copied between two of the four new files, so two files claim
  the same thing about different code;
- a moved test whose docblock still describes its old neighbours;
- a citation re-pointed in one artifact and not its twin (spec §4 of the
  solve-issue skill — the same claim in the source comment, the spec, and the
  PR body);
- the §3.8 reconciliation not adding up after four independent tasks.

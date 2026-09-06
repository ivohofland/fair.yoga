# The parallel-tier files that still stage lock contention

Issue #468. Design spec. Continues #459, whose method
(`docs/superpowers/specs/2026-09-05-lock-contention-extraction-design.md`)
this follows and whose cost argument this replaces with a measured one.

## 1. What the issue asked, and what measuring it changed

The direction survives contact with the code: seven files remain, each needs a
written verdict, and the sweep is a floor for finding candidates rather than a
census. Four of the issue's supporting claims did not survive, and three of the
seven verdicts are not the ones the issue implies.

### 1.1 The arithmetic in the issue does not close

The issue writes:

> Twelve are already serial — seven on `LOCK_CONTENTION_TESTS` (…) and four on
> `SWEEP_TESTS` (…). One more … is a **comment-only** hit … 19 − 12 − 1 = **7**.

`7 + 4 = 11`, not twelve; and `19 − 12 − 1 = 6`, not seven. With eleven the sum
closes: **19 − 11 − 1 = 7**, and the seven files it names are the right seven.
Re-derived here, against this tree:

```
grep -rlnE "SELECT .*FOR (UPDATE|KEY SHARE|NO KEY UPDATE|SHARE)|SET LOCAL lock_timeout|setLockTimeout\(" \
  --include='*.test.ts' src
```

19 files. Seven of them are `LOCK_CONTENTION_TESTS` members
(`db-locks-lock-order`, `gdpr-lock-order`, `invitations-lock-order`,
`room-archive-lock-order`, `template-lock-order`, `waitlist-lock-order`,
`class-template-lifecycle-lock-order`); four are `SWEEP_TESTS` members
(`class-transitions`, `studio-class-generator`, `waitlist-reconciliation`,
`waitlist-retention`); one, `class-template-lifecycle.test.ts`, is a
comment-only hit.

### 1.2 `LOCK_CONTENTION_TESTS` has FOUR members the sweep cannot reach, not two

The issue says "the list's other two members stage contention this grep cannot
reach, DDL and an insert race". The list has eleven members and seven appear in
the sweep, so **four** do not: `class-lifecycle-tier-guard.test.ts` (DDL),
`roster-link.test.ts`, `src/app/api/classes/route.test.ts` and
`class-room-race.test.ts` (three insert/FK races). The clause is inherited
verbatim from #459's spec §1.6, which had it wrong the same way when the list
held nine members and five appeared in the sweep.

The correction changes nothing downstream — those four are already serial
either way — but it is the second time this sentence has been carried forward
unchecked, so it is stated here rather than left to a third.

### 1.3 `api-errors.test.ts` is a SECOND comment-only hit, and it touches no database

The issue names one comment-only hit (`class-template-lifecycle.test.ts`) and
puts `api-errors.test.ts` among "the remaining three [that] have had no
per-test adjudication at all". The adjudication is indeed missing; the verdict
is not close.

`src/lib/api-errors.test.ts` has exactly one sweep hit, at `:589`, inside a
docblock ("a `$queryRaw ... FOR UPDATE` blocked past `SET LOCAL lock_timeout =
'300ms'`"). The file imports `Prisma` for its error CLASSES and never
constructs a `PrismaClient`: every `55P03` and `40P01` it asserts on is a
`Prisma.PrismaClientUnknownRequestError` built by hand from a transcribed
message, and its only I/O is `readFileSync` over `prisma/migrations/**` through
`tests/migration-sql.ts`. It cannot stage contention and cannot suffer it.

### 1.4 Three files hold MORE contention tests than the issue names

| File | Issue names | Adjudicated |
|---|---|---|
| `class-lifecycle.test.ts` | 1 | **2** |
| `studio-class-template-lifecycle.test.ts` | 1 | **4** |
| `class-generator.test.ts` | (unadjudicated) | **12** |

The one the issue missed in `class-lifecycle.test.ts` is the more interesting:
`decides from the class row the holder left behind, not from a read taken
before the wait` holds a `Class … FOR UPDATE` for 900 ms and races
`completeClass` against a 400 ms timer, asserting `'waiting'` — the same
`Promise.race` shape as `gdpr.test.ts`'s `:453`, which #459 moved.

### 1.5 What held

- The seven files the issue names are the right seven.
- `transition-class-lock-order.test.ts` is exactly as described: it stages
  contention through `lockClassRow`, carries the `*-lock-order.test.ts`
  filename, and is on neither the list nor the marker. Measured: **1 test,
  58 ms**, file 1.53 s solo — the cheapest entry the serial tier will ever get.
- `room-archive.test.ts` is the file `vitest.tiers.ts` names as a deliberate
  parallel-tier holder, and it does hold a `ClassTemplate … FOR UPDATE` under a
  6 s ceiling. It needed a verdict; it gets one in §3.5.
- The issue's own framing — "Not a census" — is right, and §1.3 is the
  demonstration in the direction #459 did not have one for: a sweep hit that is
  a comment about a file with no database in it.

## 2. Direction

Seven files change tier; two stay. Four extractions, three markers.

| Source | Destination | New file? |
|---|---|---|
| `src/lib/api-errors.test.ts` | — | stays whole (§3.1) |
| `src/lib/db-locks.test.ts` | — | stays whole (§3.2) |
| `src/services/class-generator.test.ts` | `class-generator-lock-order.test.ts` | yes |
| `src/services/class-lifecycle.test.ts` | `class-lifecycle-lock-order.test.ts` | yes |
| `src/services/room-archive.test.ts` | `room-archive-lock-order.test.ts` | no — **appends** |
| `src/services/studio-class-template-lifecycle.test.ts` | `studio-class-template-lifecycle-lock-order.test.ts` | yes |
| `src/services/transition-class-lock-order.test.ts` | itself | marker + list entry only |
| `src/services/update-class-lock-order.test.ts` | itself | marker + list entry only (§3.9) |
| `src/services/template-room-race.test.ts` | itself | marker + list entry only (§3.10) |

The last two are not among the seven the issue named. §1.1's sweep cannot see
them, because neither writes lock machinery in its own source text: one takes
its locks inside `completeClass`/`lockClassRow`, the other through a Prisma
`scheduleRule.update` whose foreign-key cascade does the locking. Either way
the regex has nothing to match — the false negative §1.1 itself warns about,
biting. §5
records how they were found and why the sweep's re-run still returns 19.

`room-archive-lock-order.test.ts` already exists, already carries the marker and
is already listed — the same append `gdpr-lock-order.test.ts` took in #459, and
for the same reason: one sibling per source file, no third naming pattern.

**`class-lifecycle.test.ts` ends with two serial siblings, deliberately.**
`class-lifecycle-tier-guard.test.ts` is already one, but its reason is DDL
taking ACCESS EXCLUSIVE on `Registration` — a different mechanism, stated in its
own header, and its name is about the tier guard it holds rather than about lock
order. Appending row-lock races to it would put them in a file named for
something else. A second sibling under the established `*-lock-order.test.ts`
name is the smaller distortion.

**Fixtures are duplicated, not shared** — the same call #459 made, for the same
reason. `createClassFixture` (`tests/class-fixtures.ts`) and `fixtureRun`
(`tests/room-fixtures.ts`) stay shared because they already are.

### 2.1 Why extract rather than move whole files — the measured reason, which is not #459's

#459's argument was cost: moving `gdpr.test.ts` whole cost the serial tier +92 %
where extracting its nine blocks did not. **That argument does not carry here,
and pretending it does would be the easy error.** Measured per file (solo, in
`unit`, reported test time):

| File | tests | movers | movers' share |
|---|---|---|---|
| `class-generator.test.ts` | 14.47 s | 13.84 s | **96 %** |
| `class-lifecycle.test.ts` | 3.85 s | 3.13 s | **81 %** |
| `room-archive.test.ts` | 2.33 s | 2.05 s | **88 %** |
| `studio-class-template-lifecycle.test.ts` | 4.84 s | 3.74 s | **77 %** |

A test that sleeps out a 2 s `lock_timeout` dominates any file it sits in, so
in all four the contention tests already ARE most of the file's runtime.
Moving the four whole would cost the serial tier `14.41 + 3.85 + 2.33 + 4.84 =
25.43 s` of test time against extraction's `13.84 + 3.13 + 2.05 + 3.74 =
22.76 s` — a difference of **2.67 s**, about 2 % of a 100 s tier. Seconds no
longer decide it.

Extraction is chosen on a different ground: **a file on
`LOCK_CONTENTION_TESTS` makes the serial tier the default home for every test
added to it afterwards.** These four hold 46, 81, 19 and 50 tests and are
actively grown; a `*-lock-order.test.ts` sibling grows only when someone writes
a contention test. That is the reason recorded in the new files' headers, not
the cost one.

## 3. The adjudication, file by file

"Machinery" means a real row or advisory lock, an injected `lock_timeout`, a
second client, or a hold a concurrent operation must queue behind. Tests are
named by title, never by line (`docs/comment-citation-sweep.md`).

### 3.1 `src/lib/api-errors.test.ts` — 59 tests — STAYS WHOLE

No `PrismaClient`, no connection, no transaction. Every SQLSTATE in it is
transcribed into a hand-built error object; the sweep's single hit is a
docblock sentence. Nothing to extract. See §1.3.

### 3.2 `src/lib/db-locks.test.ts` — 38 tests — STAYS WHOLE

This one takes real locks and still stays, so the reason has to be exact.

Four of its tests stage a genuine two-party wait:

| Test | Machinery |
|---|---|
| `makes a second transaction wait for the same key, and lets go on commit` | advisory lock held ~300 ms on a second `PrismaClient`, a second transaction parked on it |
| `does not make two slots differing in any one field wait for each other` | advisory lock held while three neighbours acquire and commit |
| `locks the Class rows and NOT the WaitlistEntry rows the join reaches` | `FOR UPDATE OF c` held across two `FOR UPDATE NOWAIT` probes |
| `locks the CalendarEntry row when entries is true, and leaves it free when omitted` | same, twice |

**None of them can be falsified by a tier-mate, and none is noise a tier-mate
would have to survive.** Three properties together:

1. Every row it locks and every advisory key it takes is its own — classes
   minted in this file's `beforeAll` under a `crypto.randomBytes` suffix, and
   advisory keys composed from string literals unique to the test.
2. **Nothing in the file waits on a clock.** `lockAnnouncementSlot`
   (`db-locks.ts`) issues no `SET LOCAL lock_timeout`, so the parked
   transaction waits for the release rather than for a bound, and the row
   probes are `NOWAIT` — they answer in one round trip instead of spending
   `lockClassRowsOrdered`'s 2 s discovering the same thing. A slipped
   `setTimeout` under load therefore delays this file; it cannot make any
   assertion in it wrong. **It is not literally unfailable, and the claim is
   scoped rather than absolute:** the file declares no per-test timeout and
   `vitest.config.ts` sets no `testTimeout`, so every test in it runs under
   vitest's 5 000 ms default, and enough delay would end one as a test timeout.
   What rules that out is margin, not mechanism — 496 ms of test time for all
   38 tests, and the file's single `setTimeout` is 300 ms against that 5 s
   ceiling.
3. No assertion in it is a bound or an elapsed time. Its `lock_timeout` tests
   read `SHOW lock_timeout`, and the two `waited >= 1_800` assertions this
   project has live in other files, which cite *this* one for the bound's value.

Its longest hold is one 300 ms `setTimeout`, against the seconds-long holds
every current `LOCK_CONTENTION_TESTS` member takes. Measured at 496 ms of test
time for all 38 tests.

### 3.3 `src/services/class-generator.test.ts` — 46 tests — EXTRACT 12

Four whole describes and two tests out of two others.

**Moving (12 tests):**

| Test | Machinery |
|---|---|
| `makes a concurrent archive wait until the claim transaction commits` | claim holds the `ClassTemplate` row ~400 ms; an archive queues under a 2 s bound; asserts `archiveSettled === false`, then `ok` |
| `answers busy when the generation claim holds the row past the lock timeout` | hold outlives the 2 s bound; asserts `waited >= 1_800` |
| `answers busy when a pause loses the row to the generation claim` | same, pause arm |
| `answers busy when the generation claim holds the row past the lock timeout (template edit)` | same, edit arm |
| `does not generate for a template archived after the list was read` | uncommitted archive holds the child row ~400 ms; the sweep's claim queues |
| `writes the values committed while the sweep was waiting, not the ones it read` | uncommitted edit, same lever |
| `names a date lost to a concurrent insert by what still holds it` | second client holds an uncommitted colliding insert ~400 ms; the generator's insert parks on the pending index entry |
| `names a short date nothing live overlaps as raced` | same, rule-date key instead of the slot exclusion |
| `leaves isActive committed when the clash lands on the last free date` | `raceResumeAgainst`: uncommitted insert held `HELD_FOR_MS`; asserts `waitedMs >= HELD_FOR_MS` |
| `still fills the other free date when the clash lands on the first` | same helper |
| `answers busy when the clash outlives the lock timeout, instead of reporting it raced` | hold outlives the 2 s bound; asserts `waited >= 1_800` |
| `answers busy when a held class row outlives the lock timeout` | second client holds a `Class … FOR UPDATE`; the archive's pre-lock queues; asserts `waited >= 1_800` |

Four of the twelve assert a lower time bound directly. The other eight assert
that a settle flag is still `false` after a fixed sleep AND that the queued
operation then succeeds — and the second half is what a tier-mate can break: a
hold pushed past 2 s by scheduling noise turns the queued archive/edit/sweep
into `busy` or a swallowed `55P03`, and the test fails on its own outcome
assertion rather than on the flag.

**Staying — the sweep's other hits in this file, and why:** `:634`, `:677`,
`:681` and `:2032` are comment text about `SET LOCAL lock_timeout`, in
docblocks belonging to tests that stay. The two `FOR UPDATE` statements at
`:781` and `:866` and the five `new PrismaClient()` holders belong to the
moving tests above.

**After:** `class-generator.test.ts` 34 tests, sibling 12.

### 3.4 `src/services/class-lifecycle.test.ts` — 81 tests — EXTRACT 2

| Test | Machinery |
|---|---|
| `decides from the class row the holder left behind, not from a read taken before the wait` | `Class … FOR UPDATE` held 900 ms; `completeClass` raced against a 400 ms timer; asserts `'waiting'` |
| `gives up on the 2s bound when another transaction holds the class row` | hold outlives the bound; asserts `55P03` and `waited >= 1_800` |

Both are in the `completeClass (DB)` describe. The `transitionClass (DB)`
describe, which two integration files cite by name, is untouched.

**After:** 79 tests, sibling 2.

### 3.5 `src/services/room-archive.test.ts` — 19 tests — EXTRACT 1, APPEND

`answers busy when the archive already holds the child row` holds a
`ClassTemplate … FOR UPDATE` on a second client until a resume answers — which
it does by waiting out the shared 2 s bound — with a 6 s ceiling behind it.
Measured at **2 047 ms**, 88 % of the file's 2.33 s. Its own comment already
says the hold "is the contention this file pays for in the PARALLEL tier".

It appends to `room-archive-lock-order.test.ts`, whose header currently
describes it as *the sibling file's* case. See H2.

**After:** `room-archive.test.ts` 18 tests, `room-archive-lock-order.test.ts`
5 (4 + 1).

### 3.6 `src/services/studio-class-template-lifecycle.test.ts` — 50 tests — EXTRACT 4

| Test | Machinery |
|---|---|
| `two concurrent archives: the loser records nothing over the winner` | `StudioClassTemplate … FOR UPDATE` held ~500 ms; two archives queue; asserts both unsettled |
| `a concurrent archive mid-resume is reported as archived, not thrown` | same lever, archive + resume |
| `a concurrent archive mid-pause is reported as unchanged, not archived` | same lever, archive + pause |
| `returns busy when another transaction holds the row past the lock timeout, and logs it` | hold outlives the bound; asserts `waited >= 1_800` and the `busy` answer |

**A correction to this spec, made during the build.** This section first said
the fourth case asserts "a lower **and an upper** bound" and called it the most
tier-fragile test in the set. It has no upper bound: `#323` (`6cb4c0e0`,
2026-08-30) removed the wall-clock ceilings from six files, and its own
docblock kept describing the deleted one for a week. The fragility ranking is
therefore the reverse — the first three sit INSIDE the 2 s bound with roughly
1.5 s of slack and two of them additionally depend on a 100 ms FIFO gap, while
the fourth has a floor and a shape assertion and cannot be broken by lateness.

A second correction, to the conclusion drawn from the first: raising
`LOCK_TIMEOUT_SQL` to `'6s'` does clear that floor and pass this case — but it
is **not** an uncaught mutation. `db-locks.test.ts` pins the literal
(`expect(LOCK_TIMEOUT_SQL).toBe("SET LOCAL lock_timeout = '2s'")`), which is
where the value lives and where all ten `waited >= 1_800` docblocks in this
repo already send it. A mutation scoped to one file proves something about that
file, not about the suite.

**Staying, and worth naming because it looks like a candidate:** `the residual
CAS miss answers busy rather than throwing` interposes through `$extends` and
targets `ScheduleRule` while the transaction holds `FOR UPDATE` on
`StudioClassTemplate` — "a different table, so no wait", as its own comment
says. Nothing is held for a duration and nothing queues. Same verdict #459 gave
`class-template-lifecycle.test.ts`'s two `$extends` interposers.

**After:** 46 tests, sibling 4.

### 3.7 `src/services/transition-class-lock-order.test.ts` — 1 test — MARKER ONLY

Its single test holds a `Class` row through `lockClassRow` while
`transitionClass` parks on it, and releases on a `pg_stat_activity` observation
rather than a timer. Its own docblock states the failure mode a tier-mate
causes: "A `55P03` lock timeout would also make `ok` false" — the transition is
itself under the 2 s bound, so noise that delays the busy-poll loop past it
turns `reason: 'CANCELLED'` into a timeout and the assertion fails for the
wrong reason.

It gets `@serial-tier lock-contention` in its own header and an entry on
`LOCK_CONTENTION_TESTS`. No extraction: the file is already the sibling.

### 3.8 Reconciliation

Counts are vitest's, re-derived with
`npx vitest list --project <tier> <file> | grep -c '^\[<tier>\]'`. None of the
19 moving tests is an `it.each`, so blocks and tests move one-for-one.

| File | Before | Moved | After |
|---|---|---|---|
| `class-generator.test.ts` | 46 | −12 | 34 |
| `class-generator-lock-order.test.ts` | — | +12 | 12 |
| `class-lifecycle.test.ts` | 81 | −2 | 79 |
| `class-lifecycle-lock-order.test.ts` | — | +2 | 2 |
| `room-archive.test.ts` | 19 | −1 | 18 |
| `room-archive-lock-order.test.ts` | 4 | +1 | 5 |
| `studio-class-template-lifecycle.test.ts` | 50 | −4 | 46 |
| `studio-class-template-lifecycle-lock-order.test.ts` | — | +4 | 4 |
| `transition-class-lock-order.test.ts` | 1 | 0 | 1 |
| `update-class-lock-order.test.ts` | 1 | 0 | 1 |
| `template-room-race.test.ts` | 1 | 0 | 1 |

Repo-wide total across the touched files is unchanged:
`46 + 81 + 19 + 4 + 50 = 200` before, `34 + 12 + 79 + 2 + 18 + 5 + 46 + 4 =
200` after. `api-errors.test.ts` (59) and `db-locks.test.ts` (38) are untouched
and excluded from both sides.

### 3.9 `src/services/update-class-lock-order.test.ts` — 1 test — MARKER ONLY

Its single test holds the `Class` and `CalendarEntry` rows through
`completeClass` — the completion is parked inside a `$extends` hook on
`class.findUnique`, which fires immediately after `lockClassRow` and before
anything the completion decides from — while `updateClass` parks on those rows
under `lockClassRow`'s own 2 s `lock_timeout`. The completion is released on a
`pg_stat_activity` observation of the reschedule's backend, not on a timer.

Its own docblock already states the failure mode a tier-mate causes: "A `55P03`
lock timeout would also make `ok` false", so `reason: 'frozen'` is the only
outcome that means what the test means. Everything between the reschedule
issuing and the holder committing has to fit inside the 2 s bound; tier noise
that pushes it past there replaces the freeze with a `55P03`, which
`updateClass` does not map to a result — its `catch` handles
`UpdateClassRefusal`, the slot exclusion and the rule-date conflict, and
rethrows everything else. So the call REJECTS and the case dies before its own
assertion, reporting a lock timeout where the defect it watches for is a stale
read. It joins on the assertion side rather than the
noise side — the hold ends on the handshake, so it is short by design. That is
the same sentence, the same device and the same consequence as §3.7 — the two
files are near-identical twins, and `transition-class-lock-order.test.ts` cites
this one BY NAME as using "the same device … and for the same reason". Both are
now on `LOCK_CONTENTION_TESTS`.

No extraction: one test, 70 ms, and the whole file is the staged race.

### 3.10 `src/services/template-room-race.test.ts` — 1 test — MARKER ONLY

Its single test holds a **`ClassTemplate`** row lock open on a resume's
transaction under `{ timeout: 15_000 }` while a second client's
`teacherRoom.update` blocks on the cascade that has to rewrite the held row.
`ClassTemplate` carries both mirrors — `ruleLive`, referencing
`ScheduleRule(id, kind, live)`, and `roomArchived`, referencing
`TeacherRoom(id, isArchived)` — so the resume's `scheduleRule.update` and the
archive's `teacherRoom.update` cascade into the SAME child row, which is what
puts them in each other's way. (This section first said `ScheduleRule`; the
test's own body says otherwise twice, and the schema settles it.) The two are joined by
`Promise.race`, and the block itself is caught by busy-polling
`pg_stat_activity` against an explicit `Date.now() + 5_000` deadline.

**That deadline is the reason, and it is stronger than a hold.** Its expiry IS
the failure — "the assertion at the foot is what fails", as its own comment
says — so a tier-mate that delays the poll past five seconds reddens the case
without touching anything it asserts about. A parked transaction waiting on a
wall clock is exactly the shape `vitest.tiers.ts`'s criterion says cannot stay
parallel. The hold is short on the passing path, since the poll is what
releases it; the failing path is where it holds that `ClassTemplate` row for
the whole five seconds, so the two halves of the criterion arrive together — the
run that breaks the assertion is also the run that makes the noise.

No extraction: one test, 18 ms, and the whole file is the staged race.


## 4. Hazards

**H1 — a prose count that extraction falsifies, and that should not exist.**
`class-lifecycle-tier-guard.test.ts` says its split "lets `LOCK_CONTENTION_TESTS`
hold it without serialising the other **81 cases** in `class-lifecycle.test.ts`".
That number is exactly right today and becomes 79. It is **deleted, not
corrected** — CLAUDE.md's *Comment Discipline* forbids a prose count outright,
and the load-bearing half of the sentence ("without serialising the rest of
`class-lifecycle.test.ts`, which has no DDL in it") needs no count.

**H2 — a sibling header that describes a test as living in the other file.**
`room-archive-lock-order.test.ts`'s header has a paragraph headed "WHAT THE
SIBLING FILE'S RACE CASE DOES NOT COVER", naming `answers busy when the archive
already holds the child row` and arguing that its own two cases exist because
that one "says nothing about what the archive itself does". After the append
that case is in *this* file, so "the sibling file's" is false and the
distinction becomes one between cases in the same file. The paragraph is
**replaced**, not annotated; the distinction it draws is still true and still
worth keeping.

**H3 — live citations of moving tests, by title.** Swept with the moving titles
as a fixed-string list, over `*.ts`/`*.tsx`/`*.md`, excluding `node_modules`
and `docs/superpowers/` (records, left alone). Live hits, each needing a
re-point:

- `src/services/entry-generation.ts` — "names a date lost to a concurrent
  insert by what still holds it" *in* `class-generator.test.ts`.
- `src/services/studio-class-generator.test.ts` — cites
  `class-generator.test.ts`'s `answers busy when the generation claim holds the
  row past the lock timeout`.
- `tests/integration/class-templates-api.test.ts` — cites the same test as a
  `class-generator.test.ts` unit test.
- `src/services/rule-lifecycle.ts`, twice — `class-generator.test.ts`, "the
  bound reaches its pre-lock" (a moving describe), and `class-generator.test.ts`,
  "answers busy when the clash outlives the lock timeout, instead of reporting
  it raced" (a moving test).
- `src/services/template-lock-order.test.ts`, twice — it cites
  `class-generator.test.ts`'s `mockImplementation` spy "on the same log line",
  and that log line (`recurring class archive lost the template lock race`) is
  asserted only by a moving test; and it cites that file's archive call by a
  title (see H3a).
- `src/services/class-lifecycle.test.ts` — the docblock of a moving test cites
  `class-generator.test.ts` for the sibling-bounds convention; it travels with
  the test and must then name the new sibling.
- `src/services/room-archive-lock-order.test.ts` — H2.
- `docs/lock-order.md`, the "independently proven necessary in …" file list —
  it names `class-generator.test.ts` and
  `studio-class-template-lifecycle.test.ts` among five files, and the cases
  doing the proving are contention cases, so both names move to the siblings.
  Its OTHER two `studio-class-template-lifecycle.test.ts` citations name "the
  residual CAS miss answers busy rather than throwing", which **stays** (§3.6)
  — leave them, including the `git log -S` command beside them.

**H3a — a citation naming a test that does not exist, found in passing.**
`src/services/template-lock-order.test.ts` says its fourth argument was
"verified against `class-generator.test.ts`'s own archive call in *answers busy
when an ordinary booking holds a class row*". No test anywhere in this repo has
that title; `grep -rn` for it returns exactly that one line, the citation
itself. The call it means is `answers busy when a held class row outlives the
lock timeout`, whose own describe docblock is the one about an ordinary
booking. Pre-existing, not caused here — folded in because this change is
already rewriting the line and leaving a known-wrong citation in a line being
edited is worse than either fixing it or not touching it.

Citations that survive untouched and must NOT be rewritten: everything naming
`db-locks.test.ts` for the 2 s value (it stays whole), the `transitionClass
(DB)` citations from `tests/integration/classes-api.test.ts`, and
`class-generator.test.ts`'s stale-`isActive` and unreadable-`startTime` cases
cited from `room-archive.ts`, `template-selection.ts` and `time-of-day.test.ts`
— all of which stay.

**H4 — the title collisions are real and are not citations.** Seven of the
nineteen moving titles are also carried by tests in three other files, nine
colliding sites in all. `studio-class-generator.test.ts` (already serial, on
`SWEEP_TESTS`) holds same-titled studio twins of five of the moving
class-family tests; `waitlist-lock-order.test.ts` holds three tests titled
`gives up on the 2s bound when another transaction holds the class row`; and
`class-template-lifecycle-lock-order.test.ts` holds `two concurrent archives:
the loser records nothing over the winner`, the class-template twin of the
`studio-class-template-lifecycle.test.ts` case moving here. A fixed-string
sweep matches all of them. They are the sweep's own false positives, not drift,
and re-pointing any of them would be the error. `docs/comment-citation-sweep.md`
carries these numbers with the command that re-derives them.

**H5 — fixture spacing and counters.** `class-generator.test.ts`'s moving
describes allocate dates from `getNextOccurrences` filtered by
`classStartInstant`, and `studio-class-template-lifecycle.test.ts`'s allocate
`ScheduleRule` slots from a running counter. Copying the wrong spacing fails at
**fixture build** under `ScheduleRule_teacher_slot_excl` /
`CalendarEntry_teacher_slot_excl`, not as a lock failure, so the error will not
look related. Each new file allocates its own teacher and its own counter; each
moving test keeps the spacing of the block it came from.

**H6 — dead imports and dead fixtures.** Every extraction leaves the source
file with imports and helpers whose last runtime use left with the tests —
`vi`/`log` where the moving tests held the only spies, `PrismaClient` holders,
`raceResumeAgainst`, `HELD_FOR_MS`, per-describe `beforeEach`/`afterEach` whose
describe is now empty. `npm run lint` catches unused imports; empty describes
and now-unused local helpers it does not. Each task removes what its own move
orphaned.

**H7 — an `afterAll` that sweeps by a shared key.** `class-generator.test.ts`
and its new sibling would mint fixtures from `Date.now()` and delete by
`teacherId`. Each new file gets its own suffix prefix (the convention
`class-lifecycle-tier-guard.test.ts` states in its own header) so the two
namespaces are disjoint by construction rather than by luck, and each sweeps
only its own teacher.

## 5. Also true, and deliberately out of scope

Nothing is deferred to a follow-up. Re-running §1.1's sweep on the finished
branch still returns **19 files** — a different 19, and every one of them now
has a verdict:

- **15 are serial.** Eleven on `LOCK_CONTENTION_TESTS` (the seven from §1.1
  plus the four this branch put there) and the same four on `SWEEP_TESTS`.
- **4 stay in the parallel tier**, and three of those are comment-only hits:
  `class-template-lifecycle.test.ts` (#459's, §1.1), `api-errors.test.ts`
  (§1.3, and it opens no database at all) and now `class-generator.test.ts`,
  whose one surviving hit is a docblock sentence about `SET LOCAL lock_timeout`
  being a no-op in a transaction kept for another reason. The fourth is
  `db-locks.test.ts`, a real lock-holder adjudicated in §3.2 and deliberately
  kept.

`15 + 4 = 19`, and `11 + 4 = 15`.

**But the serial side gained two files the sweep never returned, and that is
the finding this branch's whole-branch review produced.**
`src/services/update-class-lock-order.test.ts` and
`src/services/template-room-race.test.ts` each hold real row locks across a
staged two-party wait, and NEITHER WRITES LOCK MACHINERY IN ITS OWN SOURCE
TEXT — one locks inside `completeClass`/`lockClassRow`, the other through the
foreign-key cascade a Prisma `scheduleRule.update` sets off — so neither has a
raw `FOR UPDATE` or `setLockTimeout(` to match on. §1.1's regex reaches only
source text, so it walks past both. Note the two mechanisms are different: only
one of them is a service call, and describing both that way (as an earlier
draft of this branch's tier note did) understates how many shapes hide from a
text search. This is the
false-negative §1.1 already names — "a floor for finding candidates rather than
a census" — biting on this very branch: both files had NO verdict anywhere
until they were found by READING, and §3.9 and §3.10 give them one. Both are
now serial, so `LOCK_CONTENTION_TESTS` holds **17** members where the sweep can
account for eleven of them.

That is why `vitest.tiers.ts`'s note does not rest on a command. It says what
actually holds membership — the `@serial-tier lock-contention` marker in each
file's own header, tethered to the array by
`src/lib/serial-tier-membership.test.ts`, which fails in both directions — and
says that the command beside it is a floor for FINDING candidates and never a
census. It states the CRITERION that separates the two groups rather than
rostering either, since a roster of other files has no owner in that file.

## 6. Acceptance

1. Each of the seven files has a written verdict, above, and so do the two the
   sweep could not reach (§3.9, §3.10). The four extractions leave no moving
   test behind. Re-derived with the §1.1 sweep: `class-lifecycle.test.ts`,
   `room-archive.test.ts` and `studio-class-template-lifecycle.test.ts` drop
   out of it entirely, and `class-generator.test.ts` keeps exactly one hit, a
   comment (§5).
2. Each new sibling carries `@serial-tier lock-contention` in its own header
   with its own reason, and is on `LOCK_CONTENTION_TESTS`;
   `src/lib/serial-tier-membership.test.ts` passes. The three marker-only files
   — `transition-class-lock-order.test.ts`,
   `update-class-lock-order.test.ts` and `template-room-race.test.ts` —
   likewise.
3. The §3.8 reconciliation holds, re-derived with `vitest list`.
4. H1–H7 each addressed.
5. `vitest.tiers.ts`'s two stale paragraphs are gone — the one naming
   `room-archive.test.ts` as a known parallel-tier lock holder (that file now
   takes no lock at all) and the one pointing at #468 as the open owner of the
   rest. What replaces them states the CRITERION and rests membership on the
   marker plus `src/lib/serial-tier-membership.test.ts`, not on a command.
   `vitest.config.ts`'s own `unit` comment moves with it.
6. Both tiers measured against the baseline below. Both, because
   `.github/workflows/ci.yml`'s `test-unit` job runs them on one critical path.
7. Every moved test still passes, and each new file passes run alone.

**Baseline, measured on `0c0f43b7` (origin/main) on 2026-09-06:**
`unit` **17.48 s** (86 files, 1363 tests), `unit-sweeps` **100.24 s** (21 files,
195 tests), combined **117.72 s**. #459's final measurement on `ab9f734f` was
16.28 s / 98.74 s / 115.02 s — the same numbers within noise, on a different
machine-day, which is the check that this baseline is comparable.

Predicted: the serial tier gains the 22.76 s of test time in §2.1 plus a
per-file marginal cost of roughly 0.3 s (6.8 s of non-test time across 21 files
in the baseline run) for each of five new members — about **+24 s**, or +24 %.
The parallel tier loses its longest file's bulk (`class-generator.test.ts` is
16.05 s solo against a 17.48 s whole-tier wall clock) and should shrink.

**Measured on the finished branch, after the review that found §3.9 and §3.10:**

| Tier | Before | After | Change |
|---|---|---|---|
| `unit` | 17.48 s, 86 files, 1363 tests | **6.45 s**, 83 files, 1341 tests | **−63 %** |
| `unit-sweeps` | 100.24 s, 21 files, 195 tests | **123.62 s**, 27 files, 217 tests | **+23 %** |
| combined | 117.72 s | **130.07 s** | **+10 %** |

The baseline above was taken on 2026-09-06 and this measurement two runs later,
so `0c0f43b7` was re-measured alongside it as the comparability check the
baseline paragraph asks for: **16.33 s / 98.98 s / 115.31 s**, the same numbers
within noise. The comparison therefore holds without rebasing the table on the
re-measurement.

The serial prediction held: +23.38 s against +24 s predicted, and it absorbed
two more files than the prediction covered — §3.9 and §3.10 together are 88 ms
of test time, which is why finding two unadjudicated lock-stagers moved this
row by less than a rounding error. The parallel prediction was understated —
"should shrink" turned out to be −11.03 s, more than the serial tier gained in
test time, because `class-generator.test.ts` at 16.05 s solo *was* that tier's
critical path and 96 % of it left.

The combined +10 % is what the CI `test-unit` job actually pays, and it is the
number to compare against #459's +44 % — not because this branch was cheaper to
build, but because #459 moved time out of a tier whose critical path did not
move, and this one collapsed a critical path.

Counts reconcile in both directions. Files: 107 → 110 = three new siblings
(`room-archive-lock-order.test.ts` already existed and was appended to);
`unit` 86 → 83 as the three marker-only files leave it, `unit-sweeps` 21 → 27
as those three plus the three new siblings arrive. Tests: 1363 + 195 = 1558
before, 1341 + 217 = 1558 after — `unit` loses the 19 moved tests plus one each
from `transition-class-lock-order.test.ts`, `update-class-lock-order.test.ts`
and `template-room-race.test.ts`, and `unit-sweeps` gains exactly those 22.

## 7. Not doing

- Not moving whole files (§2.1 — for a different reason than #459's).
- Not touching `api-errors.test.ts` or `db-locks.test.ts` (§3.1, §3.2).
- Not hoisting fixtures into a shared module.
- Not changing any test's behaviour. A moved test's body changes only where a
  name it closed over has to be rebound to the new file's fixture.
- Not updating `docs/superpowers/plans/` or `docs/superpowers/specs/` records —
  they state what was true when written. `docs/comment-citation-sweep.md`'s
  closing paragraph is a snapshot of a past sweep and is likewise left alone.
- **#459 is unaffected**, and neither is #272.

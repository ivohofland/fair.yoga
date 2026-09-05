# Cross-owner decoys: proving the `Class` pre-locks are SCOPED, not merely sized

Issue #453, found by the test-coverage review of PR #451 (issue #244's fix).

The lock-order suite proves `lockClassRowsOrdered`'s callers lock the right
*number* of rows and the right *specific* rows for the fixture under test. No
test proves any caller's `WHERE` is what does the narrowing. Delete any of the
five owner/parent-scoping conjuncts across the four production call sites and
nothing names the defect: four pass green, three of those deterministically on
any machine in any database state, and the fifth is caught only by accident —
see "The fifth conjunct is caught, but by accident" below.

The fix is a decoy row per site: a `Class` that the correct predicate excludes
and a widened one would wrongly reach, plus an assertion that names it absent.

## What was measured

### The issue's premise: holds, and understates the problem

Verified by direct mutation against `ethical_yoga_test`, one conjunct at a time,
running `npx vitest run --project unit-sweeps src/services/gdpr-lock-order.test.ts`:

| Mutation | Database state | Verdict |
|---|---|---|
| `deleteTeacherAccount` pre-lock loses `e."teacherId" = ${teacherId}` | one stray qualifying row present | **RED** |
| same mutation | no stray qualifying row | **GREEN** |
| `deleteStudentAccount` pre-lock loses `w."studentId" = ${studentId}` | as found (no foreign waitlist entries) | **GREEN** |

The teacher-side RED is not the suite working. It failed by naming
`7ca0daf3-2d57-4ab2-b4d4-67e5247dee46` — a class belonging to an unrelated
teacher (`tpl-overlap-probe-…@test.local`), orphaned in the shared test
database by some earlier run's abandoned fixture. Whether the regression is
caught is decided by how much debris has accumulated: that database holds 3127
`Teacher` rows, of which 4 carried a `Class` and exactly 1 qualified. CI
provisions a fresh `ethical_yoga_test` per run (`.github/workflows/ci.yml`), so
in CI the count is whatever the serial tier's earlier files leave behind — and
the same regression that went RED locally went GREEN the moment that one row
left predicate scope.

The student side has no such luck. Its widening is green with no unrelated rows
present at all, and it stayed green across `gdpr.test.ts` and
`db-locks.test.ts` together (73 tests).

### The consequence is data loss, not just a wide lock

The teacher-side mutation **cancelled the bystander's class** — `cancelledAt`
stamped on an entry belonging to a teacher who was not being erased. The
database then refused to undo it:

```
ERROR:  CalendarEntry 6e9504bc-… is cancelled, which is terminal;
        cannot change its cancellation
CONTEXT:  PL/pgSQL function entry_reject_terminal_liveness_change() line 9
```

`entry_terminal_liveness_guard` freezes a cancelled REGULAR entry, exactly as
`CLAUDE.md` describes. So a widened `WHERE` on this Article 17 path irreversibly
cancels other teachers' classes, and the row cannot be restored afterwards. The
issue frames the gap as a lock-scope question; on this conjunct it is a
data-integrity one.

### The census: no cross-owner `Class` decoy exists anywhere

Swept `gdpr-lock-order.test.ts`, `gdpr.test.ts`, `db-locks.test.ts`,
`db-locks-lock-order.test.ts`, `template-lock-order.test.ts`,
`account-api.test.ts`, and every other caller of either erasure. Findings:

- **No test anywhere** creates a `Class`/`CalendarEntry` owned by a different
  teacher, or a `WaitlistEntry` owned by a different student, and asserts it
  survives an erasure untouched.
- The only describe that puts two live teachers in front of a
  `deleteTeacherAccount` (`gdpr.test.ts:1067`, erasure at `:1267`) creates **zero**
  `Class` rows, so the `e."teacherId"` conjunct has nothing to wrongly match.
- The issue's citation is **correct**: `gdpr.test.ts:1274` —
  `expect(await prisma.invitation.count({ where: { teacherId: inviterId } })).toBe(1)`
  under the comment "the other teacher's contacts are none of this erasure's
  business" — is the single cross-owner survival assertion in the entire suite,
  and it is about `Invitation`.
- A near-miss worth recording: `gdpr.test.ts:2415` already has a foreign
  student (`waiter`) holding a `WaitlistEntry` while a `deleteStudentAccount`
  runs, and the erased student there holds only a `Registration` — so the
  correct pre-lock matches zero classes while a widened one matches the
  waiter's. Nothing asserts the difference.
- `db-locks.test.ts` has two students, but `studentB` exists to prove join
  DEDUPE (`:526`), and every `lockClassRowsOrdered` call in that file is
  teacher-scoped. `template-lock-order.test.ts:652` has a second student
  holding a `Registration`, not a `WaitlistEntry`, so it is invisible to
  `CLASS_TO_WAITLIST_JOIN`.

### The scoping conjuncts are five, and they are not alike

Re-derive the call-site set with the command `db-locks.ts` ships:

    grep -rn 'VERDICT (#327)' src --exclude=db-locks.ts

— four hits: two in `gdpr.ts`, one in `waitlist.ts`, one in
`class-template-lifecycle.ts`. All four narrow by owner or parent. The two the
issue does not name are **worse**, because their widenings key on a per-run
unique fixture id, so no accumulated debris can ever fail them:

| Site | Conjunct | What a widening does | Witness (see the shadowing note below) |
|---|---|---|---|
| `gdpr.ts:1135` `deleteTeacherAccount` | `e."teacherId"` | cancels bystanders' classes, irreversibly | locked ids |
| `gdpr.ts:442` `deleteStudentAccount` | `w."studentId"` | widens lock set only | locked ids |
| `waitlist.ts:1094` `withdrawWaitingEntriesForTeacher` | `e."teacherId"` | withdraws the student's entries on **other teachers'** queues | locked ids |
| `waitlist.ts:1095` same | `w."studentId"` | widens lock set only | locked ids |
| `class-template-lifecycle.ts:756` archive | `e."scheduleRuleId"` | widens lock set only | locked ids |

**The locked-id set is the witness for all five, and the survival assertions
witness none of them.** This corrects an earlier draft of this table, which
listed "locked ids **+** decoy survives" for the two data-loss rows as though
both instruments fired. Measured across Tasks 1 and 2, on every mutation run:
the `expect(lockSets[0]).toEqual([…])` assertion sits above the survival
assertions in each test and fails FIRST, so vitest throws out of the test body
and the survival assertion never executes. A pre-lock widening is therefore
witnessed by the lock set and by nothing else, in all five cases.

That does not make the survival assertions dead weight — it means they guard a
DIFFERENT mutation class. Where the write below the pre-lock re-derives its own
scope (`gdpr.ts`'s `waitlistEntry.deleteMany` on `studentId`, `waitlist.ts`'s
`updateMany` on `input.studentId`, `CLASS_FAMILY.deleteWhere` on
`scheduleRuleId`), it is that re-derivation the survival assertion pins, and a
widened lock cannot reach the decoy at all. Where the write instead takes its
target set FROM THE LOCK — `gdpr.ts`'s CAS cancel loop, and the
`classId: { in: classIds }` half of `waitlist.ts`'s `updateMany` — a widened
lock does reach the decoy, and the row really does change; the assertion still
never runs, because the lock-set assertion above it throws first.

**"Never executes" is not "would have passed."** Measured in Task 2 with a
one-run diagnostic that relaxed the lock-set assertion to `toContain`, so the
survival assertions could execute:

- under mutation 4 (`w."studentId"` dropped) both waitlist survival assertions
  passed — that widening writes nothing extra, so those lines are shadowed AND
  would have held;
- under mutation 3 (`e."teacherId"` dropped) decoy 1's assertion FAILED,
  `expected 'removed' to be 'waiting'` — shadowed, but the write does reach the
  row.

Both diagnostics were reverted.

Consequence for anyone reading a failure: a broken scoping conjunct always
reports as an array mismatch naming the foreign id, never as "the bystander was
cancelled". The comment beside each survival assertion has to say so, or the
next reader will assume it proved something it never ran to prove.

**This corrects the issue's acceptance criterion, twice over.** It offers
"asserts it is NOT among the locked ids (or, more strongly, is never touched by
the erasure at all)". The stronger form fails for two separate reasons, and the
second is the more general.

FIRST: at three of the five conjuncts the write re-derives its own scope, so a
widened lock cannot reach the decoy at all and there is nothing to observe:

- `waitlist.ts:1104` re-scopes its `updateMany` with
  `{ studentId: input.studentId, classId: { in: classIds }, status: 'waiting' }`
  — so dropping `w."studentId"` changes not one written row.
- `rule-lifecycle.ts:695` deletes through `family.deleteWhere(scheduleRuleId, today)`,
  the notification read re-scopes at `class-template-lifecycle.ts:793`, and
  `remaining` re-scopes through `standingWhere` — so dropping
  `e."scheduleRuleId"` deletes, cancels and notifies exactly the same rows.

SECOND, and this covers the remaining two: even where the write DOES reach the
decoy — the two data-loss rows — the lock-set assertion above it fails first and
the survival assertion never executes (see the shadowing note above). So the
stronger form is unobservable at all five, not three: at three because nothing
happens, at two because the test stops before it could be seen.

**The returned locked-id set is therefore the only witness anywhere**, which is
why every site below asserts on it. The survival assertions stay for the write
predicates they pin, not for the conjunct beside them.
The template site's sole reachable symptom otherwise is lock
contention: a rule-unscoped pre-lock takes `FOR UPDATE` on every future
scheduled class in the database and would collide intermittently with parallel
tier neighbours, surfacing as a 2s `lock_timeout` swallowed into
`{ ok: false, reason: 'busy' }` (`rule-lifecycle.ts:813`) — machine- and
schedule-dependent, and therefore not a guard.

### The fifth conjunct is caught, but by accident — and the catch names nothing

Measured during Task 1, and it corrects this document's own first draft, which
said all five conjuncts pass green. Dropping `e."teacherId"` and running the
whole of `gdpr.test.ts` reddens TWO tests: the new decoy test, and the
pre-existing `GDPR (DB) > teacher deletion cancels upcoming classes, notifies,
and anonymizes`, which fails with `expected null not to be null` — a
notification its own student never received.

The mechanism, verified directly rather than taken from the report: the CAS
cancel loop that follows the pre-lock (`gdpr.ts`, the `tx.calendarEntry.
updateMany` keyed on `id: cls.calendarEntry.id`, `cancelledAt: null`,
`classes: { some: { status: … } }`) carries **no second `teacherId` check**. The
pre-lock's `WHERE` is the only thing scoping the cancel to the teacher being
erased. So a widened predicate does not merely over-lock — every
`deleteTeacherAccount` call in the run cancels every live cancellable class in
the database, and a sibling describe's fixture is cancelled out from under it
before that describe's own erasure runs, which is why its notification never
appears.

Two things follow, and they pull in opposite directions:

- The conjunct matters more than "lock scope" suggests. It is the sole guard on
  a destructive write, not a performance property.
- The accidental catch is worth nothing as a guard. It fires in an unrelated
  test, with a message (`expected null not to be null`) that names neither the
  pre-lock, the scope, nor the bystander — a maintainer reading it would
  reasonably start debugging the notification code. A guard that fires in the
  wrong place with the wrong message costs more than it saves.

Not measured: whether that sibling test also reddens with the new describe
ABSENT. The run that produced this had the new fixture present, so the claim
here is bounded to what was observed.

### Why the guard cannot live in the helper

`lockClassRowsOrdered` takes its predicate as a caller-supplied `Prisma.Sql`
fragment, so scope is a property of the CALL SITE, not of the helper. No test in
`db-locks.test.ts` could cover it, and the helper has nowhere to assert it from.
This is why the work is three new test blocks across three service test files
rather than one test of the helper.

### Why a text assertion is not enough

`gdpr.test.ts:3139` already reads the pre-lock's predicate, via
`source.where.strings.join(' ? ')`, and pins the rendered status list. Extending
it to also require the substring `e."teacherId" = ` would be two lines and
deterministic — and would still be the wrong instrument. `.strings` is the
tagged template's STATIC text: the owner id is a bound value, so it renders as
`?` and is invisible. Such a pin catches a *deleted* conjunct and cannot catch a
*wrong-owner* one (`e."teacherId" = ${someOtherId}` satisfies it). It is not
part of this design.

## Design

One idiom, five conjuncts, three files. A decoy is a row the CORRECT predicate
excludes and a widened one includes; the assertion names the correct id set
exactly, so the decoy's absence is asserted positively rather than by a
`not.toContain`.

Every site captures the locked ids the same way — the spy pattern
`gdpr.test.ts:3139` already establishes, calling through to the real
implementation so the erasure/unlink/archive still runs for real:

```ts
const original = dbLocks.lockClassRowsOrdered;
const lockSets: string[][] = [];
const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
  const ids = await original(tx, source);
  lockSets.push(ids);
  return ids;
});
onTestFinished(() => spy.mockRestore());
```

Each site asserts `lockSets` has exactly one member — the same "exactly one
firing" discipline `gdpr-lock-order.test.ts:548` keeps, so a future sibling
statement fails by name rather than silently changing what is asserted.

### A. `gdpr.ts` — both erasures (`src/services/gdpr.test.ts`)

A new describe, sibling to the existing `the cancellable-status classification
reaches the pre-lock (#245)`, in the parallel `unit` tier.

**One decoy serves both conjuncts.** A decoy class owned by a decoy teacher,
carrying a decoy student's `waiting` entry, is excluded by
`e."teacherId" = victimTeacher` and by `w."studentId" = victimStudent` alike,
and qualifies for either widening.

```
fixture:  victimTeacher + classA (open, future, live entry)
          victimStudent -> waiting entry on classA
          decoyTeacher  + classD (open, future, live entry)
          decoyStudent  -> waiting entry on classD
```

Two tests, presented student-first (see the correction below on why the order
is not, in fact, load-bearing):

1. **student erasure first.** `deleteStudentAccount(prisma, victimStudent)`;
   assert the lock set is exactly `[classA]`. It leaves `classA` and
   `victimTeacher` standing, so test 2's fixture is intact. Assert
   `decoyStudent`'s entry on `classD` still exists and is still `waiting` —
   honestly labelled: that assertion cannot fail on this widening (the
   `deleteMany` is `studentId`-scoped), and is there against a different
   regression, the `deleteMany` losing its own scope.
2. **teacher erasure second.** `deleteTeacherAccount(prisma, victimTeacher)`;
   assert the lock set is exactly `[classA]`, and that `classD`'s entry still
   has `cancelledAt === null`. The lock set is what witnesses the mutation: the
   widening does cancel `classD`, but the equality assertion throws first and
   the survival line never executes (see the shadowing note above). That line
   is there for a different reason — the CAS cancel loop below the pre-lock
   carries no `teacherId` check of its own, so it is what fails if the loop's
   scope ever stops coming from the pre-lock's `WHERE`. Nothing asserts the
   `classD` **row** still exists: a teacher erasure cancels entries, it never
   deletes `Class` rows, so such an assertion could not fail on any mutation of
   this predicate.

**The order is NOT load-bearing, and this document said it was.** The first
draft argued the student erasure had to run first because the teacher erasure
cancels `classA`'s entry and a cancelled entry is terminal. False on two
counts, both checkable at the source: `deleteStudentAccount` writes no
`CalendarEntry` column at all (its own `VERDICT (#327)` comment says so), so
`entry_terminal_liveness_guard` is never in its path; and its pre-lock carries
no status or liveness filter (`w."studentId" = ${studentId}` alone), so a
cancelled `classA` still matches. Task 1's reviewer swapped the two tests and
the file stayed 37/37.

What IS true and worth stating: the two tests share one fixture and each
erasure is one-shot — an erased account cannot be erased again — so neither
test can be re-run against the fixture on its own, and an `it.only` on either
one still needs the whole `beforeAll`.

Precondition: `victimStudent` is created WITH an `Account`
(`deleteStudentAccount` deletes its sessions and passkeys and anonymises the
account's email, but only when no other live teacher profile shares that
account — a student with no account skips that branch entirely), as
`gdpr-lock-order.test.ts:190` does. The decoy student needs none — nothing
erases it.

### B. `waitlist.ts` — `withdrawWaitingEntriesForTeacher` (`src/services/waitlist.test.ts`)

Its home is the file that owns the predicate, though its only production caller
is `unlinkTeacher` (`invitations.ts:1019`). The test drives `unlinkTeacher`
rather than the service directly: `withdrawWaitingEntriesForTeacher` takes a
branded `TransactionClientOnly`, and reaching it directly needs a cast that
`unlinkTeacher(db: PrismaClient, …)` makes unnecessary — the production path
runs for real and no brand is subverted.

**Two decoys, one per conjunct:**

```
fixture:  teacherT + classT ; studentS -> waiting on classT ; link(T,S)
          decoy 1: teacherT2 + classT2 ; studentS  -> waiting on classT2
          decoy 2:            classT3(of T) ; studentS2 -> waiting on classT3
```

`unlinkTeacher(prisma, { teacherId: T, studentId: S, accountEmail })`, then:

- the lock set is exactly `[classT]`;
- **decoy 1 survives**: `studentS`'s entry on `classT2` is still `waiting`. The
  `updateMany` is keyed on `studentId` and on the ids the lock returned, so a
  widened lock does reach this row and does withdraw it — measured, under
  mutation 3. It is still the lock set that witnesses `e."teacherId"`, because
  the equality assertion above throws first and this line never executes under
  that mutation (see the shadowing note above); what this line guards on its
  own is the `updateMany` keeping the `classId` set it was given;
- decoy 2's entry (`studentS2` on `classT3`) is untouched. The ROW is what makes
  the lock-set assertion able to fail under the `w."studentId"` widening —
  `classT3` joins the locked ids there. The assertion on it is a consistency
  check on that row rather than a guard: no single-fault mutation of the write
  can flip it, since the `updateMany` re-scopes on `studentId` and dropping its
  `classId` set reaches decoy 1 instead. Labelled as such in the code.

`classT3` belongs to teacher T, so it must not collide with `classT` under
`CalendarEntry_teacher_slot_excl`: distinct, non-overlapping start times.

Two preconditions, both of which turn a wrong fixture into a vacuous test
rather than a visible error:

- **The `TeacherStudent` link must exist.** Without it `unlinkTeacher` returns
  `{ ok: false, reason: 'NOT_LINKED' }` at `invitations.ts:976`, before the
  pre-lock runs at all. The `lockSets` length assertion is what catches this,
  which is why it is not optional.
- **`accountEmail` must be lowercase.** `requireNormalised`
  (`invitations.ts:991`) throws on a mixed-case address.

### C. `class-template-lifecycle.ts` — the archive pre-lock (`src/services/class-template-lifecycle.test.ts`)

A new test inside the existing archive describe, which already has the two
helpers this needs: `makeTemplate(classType)` mints a fresh rule under the same
teacher (spacing its slot to satisfy `ScheduleRule_teacher_slot_excl`), and
`makeClass(scheduleRuleId, { date, status })` puts a class under a rule.

**The decoy is a second rule of the same teacher** — the right decoy for
`e."scheduleRuleId"`, and one that a same-teacher predicate could not
accidentally exclude:

```
fixture:  ruleUnderTest + classU (future, open)
          decoyRule     + classV (future, open)   <- both of the SAME teacher
```

`archiveOrUnarchiveTemplate` on the template under test, then: the lock set is
exactly `[classU]`, and `result.deleted` is 1 so the archive is known to have
reached its own class.

`classV`'s survival is asserted too, in one line and labelled with what it
cannot catch. It cannot fail on THIS widening — per the asymmetry table the
delete re-scopes itself — but it guards `deleteWhere`'s own `scheduleRuleId`
scope, which is a real and separate regression, and sections A and B both carry
the same kind of honestly-labelled assertion. Consistency across the three
blocks is worth the line.

The census found that from the second archiving test onward this describe
*already* leaves foreign-rule classes standing (there is no per-test cleanup,
only `afterAll`), so the decoy is partly present by accident today. It is built
explicitly anyway: an assertion resting on a neighbour test's leftovers is the
same defect this issue is about.

## Not in scope

- **The other conjuncts at these sites.** `e."cancelledAt" IS NULL`,
  `c.status IN (…)`, `w.status = 'waiting'` and `e.date > ${today}` are liveness
  and window predicates, not owner scoping. The status list already has its own
  pin (`gdpr.test.ts:3153`). #453 is about scope.
- **The text pin.** Rejected above, with reasons.
- **Production code.** This branch changes no `src/` file outside `*.test.ts`.
  The five conjuncts are all correct today; what is missing is the proof.
- **The orphan debris.** 3127 stale `Teacher` rows in `ethical_yoga_test` are
  what made the teacher-side catch incidental. Cleaning that database, or making
  fixtures self-reaping, is a separate concern and is not addressed here.
- **`tests/integration/invitations-api.test.ts`.** Site B's existing coverage
  lives there, driven through the DELETE route — out-of-process, so the spy
  cannot reach it. Untouched.

## Verification

**Five mutations, five recorded failures.** Per conjunct: delete it, run the
owning test file, record the exact assertion output, restore, re-run green. A
conjunct whose mutation does not fail the new assertion has not been covered,
whatever the assertion says.

| # | Mutation | Must fail |
|---|---|---|
| 1 | `gdpr.ts:1135` drop `e."teacherId" = ${teacherId}` | A, test 2 (lock set — `classD` is cancelled too, but the run stops before that line) |
| 2 | `gdpr.ts:442` replace `w."studentId" = ${studentId}` with `w."position" >= 0` | A, test 1 (lock set) |
| 3 | `waitlist.ts:1094` drop `e."teacherId" = ${input.teacherId}` | B (lock set — decoy 1 is withdrawn too, but the run stops before that line) |
| 4 | `waitlist.ts:1095` drop `w."studentId" = ${input.studentId}` | B (lock set) |
| 5 | `class-template-lifecycle.ts:756` drop `e."scheduleRuleId" = ${scheduleRuleId}` | C (lock set) |

Mutation 2 is a replacement rather than a deletion because `w."studentId"` is
that predicate's only conjunct and the `where` member is required, so an empty
fragment is not a runnable mutation. Coverage is unaffected: a wrong-owner
variant is caught by the same equality assertion as a missing one.

Mutations 1 and 3 write to rows outside their fixture, so they must be run with
the database's other qualifying rows accounted for, and any row they damage
recorded — a cancelled entry cannot be restored (see above).

**Determinism argument, which is the point of the whole change.** Under the
correct predicate the lock set contains only rows owned by a fixture-unique
owner, so no concurrent file in the parallel tier can perturb it. Under a
widened one the decoy always qualifies. The assertion therefore fails on the
mutation on every machine and in every database state — which is precisely what
today's row-set assertion cannot do.

`npm run verify` before pushing (typecheck, lint, and every vitest project).

## Sequencing

Three independent tasks, one per test file — A, B, C in any order; none depends
on another's fixtures. Each task ends with its own mutations from the table
above proven, not merely with a green test.

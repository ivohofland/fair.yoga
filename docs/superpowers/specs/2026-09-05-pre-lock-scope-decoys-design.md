# Cross-owner decoys: proving the `Class` pre-locks are SCOPED, not merely sized

Issue #453, found by the test-coverage review of PR #451 (issue #244's fix).

The lock-order suite proves `lockClassRowsOrdered`'s callers lock the right
*number* of rows and the right *specific* rows for the fixture under test. No
test proves any caller's `WHERE` is what does the narrowing. Every one of the
five owner/parent-scoping conjuncts across the four production call sites can be
deleted and the suite still passes — three of them deterministically, on any
machine, in any database state.

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

| Site | Conjunct | What a widening does | Instrument that can witness it |
|---|---|---|---|
| `gdpr.ts:1135` `deleteTeacherAccount` | `e."teacherId"` | cancels bystanders' classes, irreversibly | locked ids **+** decoy uncancelled |
| `gdpr.ts:442` `deleteStudentAccount` | `w."studentId"` | widens lock set only | locked ids only |
| `waitlist.ts:1094` `withdrawWaitingEntriesForTeacher` | `e."teacherId"` | withdraws the student's entries on **other teachers'** queues | locked ids **+** decoy stays `waiting` |
| `waitlist.ts:1095` same | `w."studentId"` | widens lock set only | locked ids only |
| `class-template-lifecycle.ts:756` archive | `e."scheduleRuleId"` | widens lock set only | locked ids only |

**This corrects the issue's acceptance criterion.** It offers "asserts it is NOT
among the locked ids (or, more strongly, is never touched by the erasure at
all)". The stronger form is *impossible* at three of the five conjuncts, because
at those sites the write re-derives its own scope and cannot be reached by a
widened lock:

- `waitlist.ts:1104` re-scopes its `updateMany` with
  `{ studentId: input.studentId, classId: { in: classIds }, status: 'waiting' }`
  — so dropping `w."studentId"` changes not one written row.
- `rule-lifecycle.ts:695` deletes through `family.deleteWhere(scheduleRuleId, today)`,
  the notification read re-scopes at `class-template-lifecycle.ts:793`, and
  `remaining` re-scopes through `standingWhere` — so dropping
  `e."scheduleRuleId"` deletes, cancels and notifies exactly the same rows.

At those three, **the returned locked-id set is the only available witness**,
which is why every site below asserts on it and only two add a survival
assertion. The template site's sole reachable symptom otherwise is lock
contention: a rule-unscoped pre-lock takes `FOR UPDATE` on every future
scheduled class in the database and would collide intermittently with parallel
tier neighbours, surfacing as a 2s `lock_timeout` swallowed into
`{ ok: false, reason: 'busy' }` (`rule-lifecycle.ts:813`) — machine- and
schedule-dependent, and therefore not a guard.

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

Two tests, in this order — the order is load-bearing and stated in the file:

1. **student erasure first.** `deleteStudentAccount(prisma, victimStudent)`;
   assert the lock set is exactly `[classA]`. It leaves `classA` and
   `victimTeacher` standing, so test 2's fixture is intact. Assert
   `decoyStudent`'s entry on `classD` still exists and is still `waiting` —
   honestly labelled: that assertion cannot fail on this widening (the
   `deleteMany` is `studentId`-scoped), and is there against a different
   regression, the `deleteMany` losing its own scope.
2. **teacher erasure second.** `deleteTeacherAccount(prisma, victimTeacher)`;
   assert the lock set is exactly `[classA]`, **and** that `classD`'s entry has
   `cancelledAt === null` and the `classD` row still exists. This second
   assertion is the data-loss witness, and it is the one that fails on the
   mutation measured above.

Running the student erasure first is required: the teacher erasure cancels
`classA`'s entry, and a cancelled entry is terminal.

Precondition: `victimStudent` is created WITH an `Account`
(`deleteStudentAccount` erases sessions and the account row), as
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
- **decoy 1 survives**: `studentS`'s entry on `classT2` is still `waiting`. This
  is the data-loss witness for `e."teacherId"` — the `updateMany` is keyed on
  `studentId` and the returned ids, so a widened lock reaches it;
- decoy 2's entry (`studentS2` on `classT3`) is untouched — again labelled as
  unable to fail on the `w."studentId"` widening, which the lock-set assertion
  is what catches.

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
| 1 | `gdpr.ts:1135` drop `e."teacherId" = ${teacherId}` | A, test 2 (lock set **and** `classD` cancelled) |
| 2 | `gdpr.ts:442` drop `w."studentId" = ${studentId}` | A, test 1 (lock set) |
| 3 | `waitlist.ts:1094` drop `e."teacherId" = ${input.teacherId}` | B (lock set **and** decoy 1 withdrawn) |
| 4 | `waitlist.ts:1095` drop `w."studentId" = ${input.studentId}` | B (lock set) |
| 5 | `class-template-lifecycle.ts:756` drop `e."scheduleRuleId" = ${scheduleRuleId}` | C (lock set) |

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

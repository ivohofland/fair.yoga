# CalendarEntry extraction, stage B — design (#327)

**Status:** decision recorded; implementation not started.

The parent design is
`docs/superpowers/specs/2026-08-24-calendar-entry-extraction-design.md`, written
before stage A shipped. It still governs: the target schema (§3), the exclusion
constraint (§4), the liveness collapse (§5), `startTime → @db.Time` (§6), the
index census and the grandfathering answer (§7), and what is left out (§9).

This document does two things that one cannot:

1. **Re-derives the parent spec's numbers against the post-stage-A tree**, and
   records where they moved. One of them was wrong at the time it was written,
   by a method that could not have produced it.
2. **Answers the four questions stage A left to this stage.** Two of them the
   parent spec named as open (§4.6's "the entry layer inherits this question,
   not this answer"); two of them nobody had named at all, and both are
   correctness questions rather than design taste.

Everything measured here was measured on 2026-08-25 against the working tree at
`9e7fae0c` and the running `fairyoga-db-1`.

---

## 1. Re-derivation: what held, what moved, what was wrong

### 1.1 Held exactly

**The field census.** Re-run with the parent spec's own command, with `///`
docblock lines excluded alongside `//`:

| Model | fields |
|---|---|
| `Class` | 31 |
| `StudioClass` | 15 |
| shared | 11 |
| `Class`-only | 20 |
| `StudioClass`-only | 4 — `cancelledAt`, `hourlyRate`, `location`, `studentCount` |

`31 + 15 − 11 = 35` union, `11 / 35 = 31%` overlap. Unchanged, because stage A
touched only the rule layer.

**The two end-instant call sites**, at the same line numbers the parent spec and
#327 both cite:

```
grep -rn "durationMinutes \* 60 \* 1000" src --include='*.ts' | grep -v '\.test\.'
src/services/class-transitions.ts:532
src/services/class-lifecycle.ts:550
```

**The TypeScript half of the liveness audit.** 48 `'cancelled'` references in
non-test `src/`, of which exactly 1 is a `case` arm — so the protection comes
from Prisma's string-literal union, not from switch exhaustiveness, exactly as
parent §2.2(d) says.

### 1.2 Moved

| Measure | parent spec | now |
|---|---|---|
| `startTime` files (non-test) | 53 | **54** |
| `startTime` refs (non-test) | 247 | **268** |
| `startTime` test files | 60 | **63** |
| `timeHHmm` validator sites | 11 | **12** |
| live `Class` rows | 32 | **35** |
| live `StudioClass` rows | 8 | 8 |

The `startTime` growth is stage A's own: `src/lib/time-of-day.ts` and the rule
layer's conversions at its callers. The row growth is ordinary local use.

### 1.3 Wrong: the SQL liveness audit is 12 predicates, not 14

The parent spec (§2.2b, §2.2c, §5.3) and #327 both state 14 live SQL
predicates — 8 spelled `'cancelled'`, 6 spelled `cancelledAt`. Both derive it
by grepping `prisma/migrations/**/*.sql`.

**A migration file is a record of an edit, not a description of the database.**
Grepping the migration corpus over-counts in two directions at once: it cannot
see that a later migration dropped an object, and it cannot tell an enforcement
predicate from a one-shot data check. The second is what happened here.

`20260821120000_cross_family_slot_guard/migration.sql:41` and `:42` sit inside
that migration's `DO $$ … END $$` pre-flight block, which counted violating
pairs once on 2026-08-21 and raised if it found any. It ran, it found none, and
it has enforced nothing since. Two of the fourteen are that block's two
liveness conjuncts.

Re-derived from the live catalog — `pg_trigger`, `pg_get_triggerdef`,
`pg_get_functiondef`, `pg_indexes` — the audit is **12**, and its shape is far
better than a flat list of fourteen:

| # | Object | Predicate | Verdict |
|---|---|---|---|
| 1 | `Class_teacher_slot_unique` (index) | `status <> 'cancelled'` | **deleted** — its columns leave the table |
| 2 | `class_cross_family_slot_insert_guard` WHEN | `NEW.status <> 'cancelled'` | **deleted** with the trigger |
| 3 | `class_cross_family_slot_update_guard` WHEN | `NEW.status <> 'cancelled'` | **deleted** with the trigger |
| 4 | `class_cross_family_slot_update_guard` WHEN | `OLD.status = 'cancelled'` | **deleted** with the trigger |
| 5 | `studio_class_reject_cross_family_slot` body | `"status" <> 'cancelled'` | **deleted** with the function |
| 6 | `StudioClass_teacher_slot_unique` (index) | `"cancelledAt" IS NULL` | **deleted** — its columns leave the table |
| 7 | `studio_class_cross_family_slot_insert_guard` WHEN | `NEW."cancelledAt" IS NULL` | **deleted** with the trigger |
| 8 | `studio_class_cross_family_slot_update_guard` WHEN | `NEW."cancelledAt" IS NULL` | **deleted** with the trigger |
| 9 | `studio_class_cross_family_slot_update_guard` WHEN | `OLD."cancelledAt" IS NOT NULL` | **deleted** with the trigger |
| 10 | `class_reject_cross_family_slot` body | `"cancelledAt" IS NULL` | **deleted** with the function |
| 11 | `class_reject_terminal_status_change` body | `OLD.status IN ('completed','cancelled')` | **survives — §4** |
| 12 | `class_terminal_date_guard` WHEN | `OLD.status = ANY(ARRAY['completed','cancelled'])` | **survives — §4** |

`10 deleted + 2 surviving = 12`. Seven are the `'cancelled'` spelling (1–5, 11,
12) and five the `cancelledAt` one (6–10).

**#327's headline is right, and this makes it provable.** It says the two
`IN ('completed','cancelled')` sites "change meaning silently rather than
erroring" and "are the two to find first". They are not merely the first two —
after this work deletes four triggers, two trigger functions and two partial
indexes, **they are the only two**. The audit is two verdicts and ten
consequences, not fourteen open questions.

Both survivors are on `Class`, both belong to the class-freeze machinery, and
both are load-bearing for a sweep that deletes rows. §4 is about them.

### 1.3.1 What the ten deletions are justified against — both halves

Ten deletions need a replacement named, and the exclusion constraint is only
half of it. **Raised at spec review, and correctly**: rows 2–5 and 7–10 are the
four cross-family guards, and the entry-level `EXCLUDE` does not by itself
close what they close. It forbids two *entries* of one teacher from overlapping.
It says nothing about how many children hang off one entry — so one entry
carrying a `Class` and a `StudioClass` at an identical span would violate
nothing, which is #296 exactly.

The other half is **disjoint occupancy**, and it is a composite foreign key.
The parent spec §3 (*"Disjoint occupancy is a composite foreign key"*) specifies
it: `UNIQUE (id, kind)` on the parent, each child carrying `(entryId, kind)`
with a `CHECK` pinning its own literal and a composite FK to `(id, kind)`.
Named here rather than left to §6's blanket carry-over, because a reader of this
document alone cannot otherwise check what ten deletions are being traded for.

**This is not a proposal — stage A shipped it, and it is live.** The rule layer
already carries the three-part structure:

```
ClassTemplate_kind_check                CHECK (kind = 'regular')
ClassTemplate_scheduleRuleId_kind_fkey  FK (scheduleRuleId, kind) → ScheduleRule(id, kind)
ClassTemplate_scheduleRuleId_key        UNIQUE (scheduleRuleId)
```

and its studio twin, pinning `'studio'`. Stage B mirrors it one layer down. The
`UNIQUE` alone would *not* close the hole: it is per-table, so one rule could
hold one child of each. Disjointness comes from the parent having a single
`kind` that both children must match and neither may forge.

**Mutation-tested against `fairyoga-db-1` on this tree**, rather than inherited:

| Mutation | Refused by | SQLSTATE |
|---|---|---|
| studio child on a regular rule, `kind = 'studio'` | `StudioClassTemplate_scheduleRuleId_kind_fkey` | `23503` |
| same, `kind = 'regular'` — forged to satisfy the FK | `StudioClassTemplate_kind_check` | `23514` |
| flip the parent's `kind` with a child attached | `ClassTemplate_kind_check` | `23514` |

**The third row disagrees with the parent spec, which records `23503` for it —
and the parent spec is the only artifact that still does.** Stage A measured
this and pinned it. `schedule-rule-constraints.test.ts:218` asserts
`/check constraint/i` and explains why in its own comment: both composite FKs
carry `ON UPDATE CASCADE`, so flipping the parent cascades into the child's
`kind` column first and the child's `CHECK` raises — *"Measured, not assumed:
the FK never gets a chance to reject anything here because the cascade already
satisfies it."* The `20260825065109_schedule_rule_backfill` migration says the
same thing about the `CHECK`'s purpose: *"The CHECK is what makes the composite
FK mean 'regular children hang off regular rules'; without it the pair would
merely have to agree."*

So the substance was known, the code is right, the test pins it — and the
correction never reached the spec. That is `.claude/skills/solve-issue` §4's
exact failure mode, committed across a stage boundary: the fix landed in the
migration, the plan and the test, and its twin in the design document stood.
Recorded here because §6 carries parent §3 forward wholesale, so a stage-B
test written from the parent spec's number would assert `23503` and fail.

**The consequence to carry down: the `CHECK` is load-bearing, not redundant with
the FK.** It reads like decoration once a composite FK already pins
`child.kind = rule.kind` — but the FK alone is satisfiable by *both* children
simultaneously, provided each agrees with the parent. Remove the `CHECK`s and
the cascade above silently rewrites the child, after which the other family
attaches to the same parent and disjointness is gone. Stage B needs both
mutations at the entry layer, and the entry-layer twin of that test comment.

**Totality is a different question and stays out** (§8). Nothing forces an entry
to have a child; parent and child are written in one transaction. Disjointness
is declarative and lands here; totality would need a deferred check and buys
nothing this work needs.

### 1.3.2 The same defect again, in §7.1's census — found by applying §1.3's lesson

**Raised at spec review**: §1.3 indicts a *method*, not one number, so every
other figure derived by grepping `prisma/migrations/**` inherits it. Parent
§7.1's index census and its `slot-constraints.test.ts` port are both derived
that way, and that census decides which tests get rewritten. Re-derived from
`pg_indexes` — a two-minute job that found the second instance.

**It is stale in both directions at once.**

*Over-counting.* §7.1 tables four `*_teacher_slot_unique` indexes. Two survive:

| Index | §7.1 | live |
|---|---|---|
| `Class_teacher_slot_unique` | dropped by this work | **present** |
| `StudioClass_teacher_slot_unique` | dropped by this work | **present** |
| `ClassTemplate_teacher_slot_unique` | merged | **gone** — stage A merged it |
| `StudioClassTemplate_teacher_slot_unique` | merged | **gone** — stage A merged it |

So §7.1's headline — *"4 partial unique indexes + 8 triggers → 2 exclusion
constraints"* — describes the arc from before stage A, not the work in front of
stage B. **Stage B's half is `2 partial unique indexes + 4 triggers → 1
exclusion constraint`**, plus the composite FK of §1.3.1. The other exclusion
constraint, `ScheduleRule_teacher_slot_excl`, is already live.

*Under-counting, in the file the port depends on.* §7.1 describes
`slot-constraints.test.ts` as 731 lines and cites case groups by line
(`:93`–`:201`, `:202`–`:251`, `:252`–`:731`). It is now **421 lines**; stage A
moved the template-layer cases into `schedule-rule-constraints.test.ts` (240).
Every line citation in §7.1 is off, and a plan written against them would
re-point cases that are no longer there.

*And the correction it already made now runs the other way.* §7.1 names **four**
"leaves a pre-existing violating pair editable on unrelated columns" cases to
delete, at `:310`, `:461`, `:684`, `:708` — and says so in an explicit
self-correction: *"Four, not two: an earlier draft counted only the
instance-level pair."* Live there are **two**, at `:247` and `:398`. The
document reasoned its way from two to four, and stage A took it back to two for
an unrelated reason. Both numbers were right when written; neither is right now.

*What holds.* Both `@@unique([templateId, date])` indexes are live
(`Class_templateId_date_key`, `StudioClass_templateId_date_key`), so §7.1's
claim that they become one `UNIQUE (scheduleRuleId, date)` on `CalendarEntry`
stands unchanged.

**The plan re-derives this census from `pg_indexes` and the file itself, never
from §7.1's line numbers.** Recorded rather than silently fixed because it is
the second instance of one method failing, and the pattern is what transfers:
a number derived from the migration corpus goes stale the moment a later
migration touches the object, and nothing in the document can notice.

### 1.4 The stop condition passes, and its zero is a real one

The §7.2 entry-layer pre-flight, re-run:

```sql
WITH e AS (SELECT "teacherId", date, "startTime"::time t, "durationMinutes" d, id FROM "Class" WHERE status <> 'cancelled'
           UNION ALL
           SELECT "teacherId", date, "startTime"::time, "durationMinutes", id FROM "StudioClass" WHERE "cancelledAt" IS NULL),
     s AS (SELECT *, tsrange(date+t, date+t+(d*interval '1 minute'), '[)') span FROM e)
SELECT * FROM s a JOIN s b ON a."teacherId"=b."teacherId" AND a.id<b.id AND a.span && b.span;
--  (0 rows)   -- against 35 live Class + 8 live StudioClass = 43 live entries
```

The parent spec warns that the *rule*-layer zero was nearly vacuous. This one is
not, and the same check confirms it: two same-teacher-same-day clusters exist
and legitimately do not overlap — 2026-08-08 at 09:00 (+75) against 11:00, and
2026-08-22 at 14:00 (+90) against 18:00. The predicate is exercised and returns
false. **Re-run this immediately before writing the migration**; an exclusion
constraint cannot be added `NOT VALID`, so the migration either builds or
aborts (§7.2).

`btree_gist` is installed already — stage A installed it for
`ScheduleRule_teacher_slot_excl` — so the extension prerequisite is discharged
rather than pending.

---

## 2. Lock coverage: `completeClass` reads three fields that stop being on the row it locks

**This is a correctness defect the extraction introduces, not a design
preference, and #327 understates it by calling it "a lock-order question".** It
is a lock-*coverage* question, and this repository has already measured the same
shape once, one layer up.

### 2.1 The mechanism today

`completeClass` (`class-lifecycle.ts`) opens with `lockClassRow(tx, classId)` —
`SELECT id FROM "Class" WHERE id = $1 FOR UPDATE` — and then computes, at
`:550`, whether the class has ended:

```ts
const start = classStartInstant(cls.date, cls.startTime, cls.teacher.defaultTimezone);
const end   = new Date(start.getTime() + cls.durationMinutes * 60 * 1000);
if (timing.requireEndedBy < end) return { ok: false, reason: 'NOT_ENDED_YET', … };
```

`updateClass`, the only writer that moves an existing class's `date`/`startTime`
(CLAUDE.md, *Class Lifecycle*), **takes no lock at all** — its own comment says
so. It is a conditional `updateMany` with `status: { notIn: TERMINAL }` in the
filter. It is correct today for a reason it never states: the row it writes is
the row `completeClass` locked, so its plain `UPDATE` blocks for free.

### 2.2 What breaks

`date`, `startTime` and `durationMinutes` move to `CalendarEntry`. `lockClassRow`
still locks `Class`. The free lock now covers the wrong table, and this
interleaving commits:

1. `completeClass` locks the `Class` row, reads the entry, computes `end`, and
   decides the class has ended.
2. `updateClass` moves the entry's `startTime` later. Its CAS checks
   `Class.status notIn TERMINAL` — true, the completion has not written yet — so
   it commits.
3. `completeClass` runs the pricing engine, creates `Payment` rows, and writes
   `status = 'completed'`.

That is #182 restored: *a class completed against a time it no longer had*, and
completion is what bills students. The window is small and the consequence is
money, so it is fixed, not accepted.

**The same shape, already measured.** Stage A's roadmap entry records it in one
sentence: `updateClassTemplate` *"takes no explicit lock at all, because its
plain `UPDATE` locked the row for free, and after the split that free lock
covered the wrong table."* Table extraction is unusually good at breaking
accidental correctness, because accidental correctness is a property of which
row holds which column.

### 2.3 Decision: `lockClassRow` locks both rows

`lockClassRow` takes the `Class` row and its `CalendarEntry` row, in that fixed
order, **naming both tables explicitly**.

- **One point of change covers ten callers.** `db-locks.ts` already states the
  convention — every `SELECT … FOR UPDATE` on a `Class` row goes through
  `lockClassRow` or `lockClassRowsOrdered` — and that convention is what makes
  this a helper edit rather than a ten-site audit.

  ```
  grep -rn "lockClassRow(tx" src --include='*.ts' | grep -v '\.test\.' | grep -v "db-locks.ts"
  ```

  `5 waitlist.ts + 2 class-transitions.ts + 1 class-lifecycle.ts +
  1 api/registrations/route.ts + 1 waitlist-retention.ts = 10`. Match on
  `lockClassRow(tx` rather than the bare name: the looser pattern returns 11,
  and the extra is a prose mention in `waitlist-retention.ts:170`.
  `registrations/route.ts:115` independently asserts the `waitlist.ts` five, so
  that term is cross-checked rather than counted once.
- **Explicit, because stage A measured the trap.** A joined `FOR UPDATE OF c`
  locks only `c`; a waiting statement's joined predicate was already evaluated
  against the pre-wait snapshot and `EvalPlanQual` never re-fetches a non-locked
  join member. Measured 6/6 in isolation from Prisma during stage A. So the
  statement must name `CalendarEntry`, not reach it through a join.
- **A new cycle is possible, and `updateClass` is the writer that creates it.**
  An earlier draft of this section claimed `updateClass` "acquires at most one
  of the two rows implicitly, so it cannot hold one and wait for the other".
  **That is false.** `TeacherEditableClassField` has ten members and the split
  cuts through it:

  | move to `CalendarEntry` | stay on `Class` |
  |---|---|
  | `classType`, `date`, `startTime`, `durationMinutes` | `description`, `roomCost`, `minRate`, `targetRate`, `minStudents`, `maxStudents` |

  `4 + 6 = 10`. One `updateClass` call can write both tables, so it takes two
  implicit row locks in whatever order Prisma emits the statements — and if
  that order is entry-then-class it deadlocks against `lockClassRow`.

  **So the mitigation is not "no cycle exists"; it is a rewrite.**
  `updateClass` opens no transaction at all today — `db.class.findUnique` then
  `db.class.updateMany`, both on the base client — so it must become an
  explicit transaction that writes `Class` before `CalendarEntry`, matching
  `lockClassRow`'s order. **Recommended further: have it call `lockClassRow`
  outright** rather than rely on emergent ordering. It already blocks on that
  lock today by accident; taking it deliberately makes the order a statement
  rather than a property of Prisma's query emission, which is the kind of
  accidental correctness §2.2 exists to stop trusting. The plan decides,
  because it changes `updateClass` from lock-free-with-CAS to lock-taking, and
  that is a concurrency-profile change a teacher-facing edit path should make
  on purpose.

- **The CAS filter guards a row it stops writing.** Also raised at review, and
  it is the same split seen from the other end. `updateClass`'s conditional
  `updateMany` carries
  `where: { id, status: { notIn: TERMINAL_CLASS_STATUSES }, …settingsLocked }`
  — a filter on `Class`. Four of the ten fields it is guarding move to
  `CalendarEntry`, where that filter does not reach, so post-split the entry
  write is unguarded and a completion committing mid-edit no longer refuses the
  reschedule. The filter is re-expressed against the entry's **own** columns —
  `classCompletedAt IS NULL AND NOT (kind = 'regular' AND cancelledAt IS NOT
  NULL)`, the same predicate §4.5 gives the guard — so it sits on the row being
  written. This is the second place where the extraction breaks a guard by
  moving the column rather than by touching the guard, and neither is visible to
  `tsc`.

  The CAS stays the primary path and §4's trigger is its backstop, which is the
  arrangement `updateClass` and `class_terminal_date_guard` already have today.

`lockClassRowsOrdered` has four production call sites (`gdpr.ts` ×2,
`waitlist.ts`, `class-template-lifecycle.ts`). **Each gets its own written
verdict** on whether it reads or writes entry-level scheduling fields — this is
a per-caller question, and widening all four by reflex would add wait edges
nothing needs.

---

## 3. The refusal cannot say what it hit — and the probe can, measured

§4.6 settled this at the rule layer and explicitly deferred the entry layer:
*"Stage B decides whether the same probe shape serves there or whether an entry
collision wants to name the class rather than the family."*

### 3.1 What the error actually carries

Measured, both Prisma error shapes, on a scratch schema carrying the §3
`CalendarEntry` shape:

**Raw** — `PrismaClientKnownRequestError`, `code: 'P2010'`:

```
Raw query failed. Code: `23P01`. Message: `ERROR: conflicting key value violates
exclusion constraint "CalendarEntry_teacher_slot_excl"
DETAIL: Key ("teacherId", span)=(T1, ["2026-09-01 19:30:00","2026-09-01 20:30:00"))
conflicts with existing key ("teacherId", span)=(T1, ["2026-09-01 19:00:00","2026-09-01 20:30:00")).`
```

**Typed** — `PrismaClientUnknownRequestError`, `code: undefined`, against the
live `ScheduleRule_teacher_slot_excl`:

```
QueryError(PostgresError { code: "23P01", …, detail: Some("Key (\"teacherId\",
\"dayOfWeek\", slot)=(f4f7d978-…, 1, [540,615)) conflicts with existing key
(\"teacherId\", \"dayOfWeek\", slot)=(f4f7d978-…, 1, [540,615))."), … })
```

So the conflicting row's key values **do** survive to TypeScript, in both
shapes. And because the constraint forbids overlap among a teacher's live
entries, `(teacherId, span)` identifies that row uniquely — a property of the
constraint, not an assumption about the data.

### 3.2 Decision: the §4.6 probe shape, returning the entry rather than the family

**Parsing the `DETAIL` is rejected, and the reason is that it would work.** Two
escapings across two error classes, no compiler tether, and a format PostgreSQL
owns. Stage A's `isExclusionConflictOn` already declined to read past the
SQLSTATE and the constraint name; this keeps that boundary.

The probe runs after the refusal, on the failure path, against the base client:

```sql
SELECT … FROM "CalendarEntry"
WHERE "teacherId" = $1 AND "cancelledAt" IS NULL AND span && $2
LIMIT 1
```

`span` is `Unsupported("tsrange")` in the schema, so this is raw SQL — the same
concession `ScheduleRule.slot` already makes.

**It returns the conflicting entry, not just its `kind`.** That is one mechanism
at both layers — which is what makes it consistent with what stage A shipped —
carrying a richer payload at the layer that can use it. Three reasons the entry
layer wants more than `heldBy`:

- **§4.6's own argument inverts here.** It kept the family discriminator because
  *"Recurring classes and studio classes remain separate surfaces in Settings, so
  'go look at your studio classes' stays the actionable half."* At the entry
  layer they are not separate surfaces: the Schedule tab at `/` lists both
  families in one list (CLAUDE.md, *Information Architecture*). Naming the
  family tells a teacher something they can already see.
- **The midnight spill makes it close to mandatory.** Parent §4.3's new capability is
  that a 23:30 +60 entry collides with 00:15 the *next* day. A teacher told only
  that "the other family holds this slot" cannot find the conflict by looking at
  the date they are editing — the conflicting row is not on it.

  **This codebase has already reached that conclusion once**, which is why the
  argument is a precedent rather than a proposal. `api/classes/[id]/route.ts`
  gives `template_date_conflict` its own message and code, and says why: that
  collision *"can fire with the two classes' times entirely different, so naming
  the time back to the teacher here would describe a clash that didn't happen."*
  A range overlap generalises exactly that situation — the collision need share
  neither a start time nor, after midnight, a date.
- **`heldBy` falls out for free.** `kind` is a column on the row the probe
  returns, so the rule layer's existing answer is a projection of this one.

`'unknown'` remains a real state for the same reason §4.6 gives, re-derived for
this layer: the conflicting entry can be cancelled between the refusal and the
probe, and a cancelled entry releases its slot. Naming nothing beats naming
wrongly.

**Precondition, to verify per site in the plan.** A statement that fails inside
a transaction aborts it, so the probe must not run on `tx`. The four entry-level
route files open no `$transaction` of their own — the services do — so the
question is per service, not per route, and `api/classes/[id]/route.ts` is
already the shape where the *service* classifies and the route maps a typed
reason.

---

## 4. The freeze: one guard's column leaves its table, and a sweep that deletes rows depends on it

Nobody had named this. It is the largest consequence of §5's liveness collapse.

### 4.1 What depends on what

`waitlist-retention.ts` reaps entries whose class is terminal and more than 365
days past its date. Its docblock states its own safety argument, and that
argument rests on the audit's two survivors:

- **`class_terminal_status_guard`** — a terminal class cannot leave its status.
- **`class_terminal_date_guard`** (#247) — a terminal class's `date` cannot
  move, *"which is what makes 'more than 365 days past' a fact rather than a
  snapshot."*

Each is pinned by a test that compares the derived `TERMINAL_CLASS_STATUSES`
against its own migration's hard-coded SQL — `class-terminal-status.test.ts` and
`class-terminal-date.test.ts` — precisely because *"deriving from a TABLE while
depending on TRIGGERS"* is the hazard the docblock names.

### 4.2 This work breaks both

- **`ClassStatus` loses `cancelled`**, so both triggers' hard-coded
  `('completed','cancelled')` narrow to `('completed')` without erroring. That
  is audit rows 11 and 12, and it is why they are the dangerous ones.
- **`Class.date` ceases to exist.** `class_terminal_date_guard` is
  `BEFORE UPDATE OF date ON "Class"`. PostgreSQL drops a trigger with the column
  it is declared on. The guard cannot survive as written, and its replacement
  would have to read terminality from a *different* table than the one it
  guards.

### 4.3 Decision: the entry carries a freeze marker, and a trigger maintains it

`CalendarEntry` gains `classCompletedAt`, a nullable timestamp meaning exactly
*the owning class completed*. It is written by **an `AFTER UPDATE OF status ON
"Class"` trigger**, never by application code. The freeze guard on
`CalendarEntry` is single-table and reads its own `OLD`.

**This is the third of three options, and it arrived at spec review after the
first two had been weighed against each other.** Both earlier candidates are
recorded because each fails for a reason worth not rediscovering, and because
the ground on which this document first rejected the cross-table option was
wrong.

| | cross-table read | marker, app-synced | **marker, trigger-synced** |
|---|---|---|---|
| reaches raw SQL | yes | **no** | yes |
| new lock edge | Entry → Class, inverts §2.3 | none | Class → Entry, matches §2.3 |
| sync obligation | none | on 3+ call sites | none |
| guard-path cost | a lock per schedule write | free | free |

**Correction: the cross-table option's stated rejection ground does not hold.**
An earlier draft rejected it because "a trigger's read runs in the statement's
snapshot, so a concurrent *uncommitted* completion is invisible to it". That is
a property of a **non-locking** read. `SELECT status … FOR SHARE` blocks on the
completing transaction's `FOR UPDATE`, and under `READ COMMITTED` `EvalPlanQual`
re-fetches the newly committed row when the lock releases — so the trigger would
see `completed` and raise. The visibility argument was simply wrong.

(It is consistent with stage A's finding that `FOR UPDATE OF ct` does *not*
re-fetch a non-locked join member. That is about join members a statement
declined to lock; this is a single-table locking read of the row in question.
Different mechanisms, and the two facts do not conflict.)

**It fails on lock order instead — measured, `40P01`.** An `UPDATE` on
`CalendarEntry` already holds that row when its trigger fires, so the trigger's
read acquires `CalendarEntry → Class`. §2.3 fixes `lockClassRow` at
`Class → CalendarEntry`. That is a straight ABBA against `completeClass`, on the
schedule-write hot path, introduced by the guard itself:

```
ERROR:  deadlock detected
CONTEXT:  while locking tuple (0,1) in relation "c"
SQL statement "SELECT status FROM c WHERE id = OLD."classId" FOR SHARE"
```

The error names the guard's own read as the waiting statement. Inverting §2.3 to
match would re-decide the ordering rule for all ten `lockClassRow` callers and
`lockClassRowsOrdered`'s four, to save one column. Rejected.

**And the app-synced marker is weaker than what it replaces — which contradicts
the reason for keeping triggers at all.** §4.1 keeps triggers because they reach
every client including raw SQL; that reach is the reaper's licence to delete. A
marker synced by the completion and cancel paths reaches only clients that go
through those paths. A raw `UPDATE "Class" SET status='completed'` leaves the
entry unfrozen, its `date` mutable, and the reaper's "more than 365 days past
its date" premise false. That trades a concurrency window for a writer-
discipline window, against the exact threat model that motivates the trigger.
An earlier draft of this document proposed it while also making the raw-SQL
argument two paragraphs earlier — an internal contradiction, not a trade-off
that was weighed.

**The trigger-synced marker has neither weakness.** The sync fires inside the
completing transaction, so the marker and the status commit atomically — no
window, and no code path can forget it, including raw SQL. Its own lock
acquisition is `Class → CalendarEntry`, the order §2.3 already chose, so it
composes rather than conflicting. Net it is one trigger added against four
deleted, and it is a write-sync rather than a cross-table read inside a guard.

**Measured, on the scratch shape.** A control first, so the test can fail: with
no completion in flight, the reschedule succeeds and the date moves. Then the
race — session 1 takes `Class` then `CalendarEntry`, sets `status='completed'`
(the sync trigger writes the marker), and holds for 3s; session 2 attempts the
reschedule 1s in:

```
[S2] ERROR:  entry e1 is frozen (class completed)
[S2] CONTEXT:  PL/pgSQL function freeze_guard() line 4 at RAISE
```

Session 2 blocked on the row lock, and when session 1 committed, `EvalPlanQual`
re-fetched the row so the `BEFORE UPDATE` trigger's `OLD` carried the
freshly-committed marker. **That re-fetch is the property the whole design rests
on**, which is why it is measured rather than reasoned: without it the guard is
porous exactly when it matters.

### 4.4 The guard's column list widens, and it is easy to carry over unchanged

`class_terminal_date_guard` is `BEFORE UPDATE OF date` — one column, because on
`Class` there was only one to name. **On `CalendarEntry` the frozen thing is the
span, and the span is generated from three columns**, so the replacement is
`BEFORE UPDATE OF date, "startTime", "durationMinutes"`.

Raised at review, and worth stating because the failure is silent in the
direction people do not look: guarding only `date` leaves a terminal class's
start time and duration mutable, which moves its span, which the exclusion
constraint then re-evaluates against every other entry. CLAUDE.md's *Class
Lifecycle* already says a terminal class is frozen as a whole — *"`updateClass`
refuses every field, 409"* — so a one-column guard would also be narrower than
the stated rule.

The status guard on `Class` needs no such widening: it is
`BEFORE UPDATE OF status`, and `status` stays on `Class`.

### 4.5 What the marker means, and why the cancel half does not need it

**Post-§5 the marker narrows to one thing.** `cancelled` is no longer a
`ClassStatus`, so terminality for the class family is `completed` alone — and
the cancel half of the freeze needs no marker at all, because `kind` and
`cancelledAt` are **both already columns on the entry**. The single-table guard
expresses it directly:

```
frozen  ⟺  OLD."classCompletedAt" IS NOT NULL
           OR (OLD.kind = 'regular' AND OLD."cancelledAt" IS NOT NULL)
```

That is tighter than an earlier draft's scope note, which had the marker
standing for "reached a terminal state" and then needed a paragraph explaining
why only one `kind` ever populates it. It does not: the marker means *the owning
class completed*, one writer writes it, and the family asymmetry falls out of
the guard's second disjunct rather than out of a documentation obligation.

**The asymmetry is still real and still belongs in the docblock**, but it is now
a one-liner about the `kind` conjunct rather than about who writes the column:
cancelling a `Class` is terminal (`VALID_TRANSITIONS` has `cancelled: []`),
while cancelling a `StudioClass` is reversible and its un-cancel path is live
(`api/studio-classes/[id]/route.ts` writes
`cancelledAt: cancelledAt ? new Date(cancelledAt) : null`). A studio entry that
is cancelled is not frozen, and must not be.

**What the marker is not.** Not a general "is this row editable" flag. The two
families' editability rules differ and stay where they are — #276's studio rule
is date-derived (`date < teacher's today`), the `Class` family's is
status-derived. `classCompletedAt` answers one question, and its name says which.

**Two texts now hard-code the terminal status list, not one.** The status guard
on `Class` and the new sync trigger both do, so `class-terminal-status.test.ts`
pins the derived constant against **both** migrations' SQL rather than one. That
is the cost this option adds, recorded because the test's whole shape exists to
catch a constant and a trigger drifting apart, and a second trigger it does not
know about is exactly the drift it would miss.

`TERMINAL_CLASS_STATUSES` is re-derived with the enum shrink, and both pinning
tests are re-pointed. They keep their shape: a derived constant compared against
migration SQL, independent texts nothing else forces to agree.

**§2.3's CAS keeps its job.** With the guard trigger-backed, `updateClass`'s
re-expressed filter on the entry's own columns stays the primary path — it
returns a clean typed refusal and a 409 — and the trigger is the backstop that
reaches raw SQL. That is exactly how `updateClass` and `class_terminal_date_guard`
relate today, per `waitlist-retention.ts`'s own argument, so the pairing is
preserved rather than invented.

---

## 5. Cancellation stops being a transition

`ClassStatus` losing `cancelled` is not only an enum edit. Today:

```ts
draft:  ['open', 'cancelled'],
open:   ['in_progress', 'cancelled'],
cancelled: [],
```

Cancellation is a *transition*, reached through `PATCH /api/classes/[id]/transition`
with `{ status: 'cancelled' }`, which `cancel-class-button.tsx` posts. Once the
member is gone there is no target status to transition to, and the wire format
would be naming a value the enum does not have.

**Decision: a dedicated cancel endpoint per family.** Each family keeps its own
door, because their duty of care genuinely differs — cancelling a `Class` must
notify registered students and close the waitlist, which the transition route
does inline today; a `StudioClass` has neither registrations nor a waitlist —
and both write the one `CalendarEntry.cancelledAt`.

`VALID_TRANSITIONS` then describes only real status transitions, which is what
it is named for. A single shared endpoint over `CalendarEntry` was rejected as
scope: it forces one handler to branch on `kind` for duties only one family has,
which is lifecycle-triad merging, and §9 leaves that out.

The un-cancel path at `api/studio-classes/[id]/route.ts:143` keeps its re-entry
comment, whose scope widens from exact-start to range overlap (parent spec,
parent §4.2 and §11 item 6).

---

## 6. Carried from the parent spec

Section numbers below refer to the **parent** spec unless prefixed "stage B".

Carried whole: §3 (target schema), §4.1–§4.5, §5.1–§5.2, §6
(`startTime → @db.Time`, wire format stays `"HH:MM"`), §7.2 (no
grandfathering), §8 (issue consequences), §9 (left out), and §11 items 1, 3, 5,
6, 7.

**Two are carried with corrections rather than whole**, and both corrections are
in stage B §1.3:

- **§3's disjoint-occupancy paragraph** recorded the parent-`kind`-flip refusal
  as `23503`; it is `23514`, from the child's `CHECK`. Stage B §1.3.1 has the
  measurement and the stage-A test that already pinned it. The parent spec is
  corrected in place rather than annotated, per CLAUDE.md's *Comment
  Discipline* — the before-and-after lives here and in the PR body.
- **§7.1's index census and `slot-constraints.test.ts` port** are stale in both
  directions: four `*_teacher_slot_unique` indexes are two, 731 lines are 421,
  four deletable cases are two, and every line citation is off. Stage B §1.3.2
  has the re-derivation. **The plan takes its census from `pg_indexes` and the
  file, not from §7.1**, which is the one carried item that must not be read
  literally.

Two of §11's items are answered above rather than carried: item 9 (the two
end-instant call sites) by §2, and §4.6's deferred question by §3.

`SkipReason`'s `blocked_by_other_family` is renamed, not supplemented — the
condition becomes "an existing entry overlaps this candidate". Nine non-test
sites carry the current member. `COUNT_KEYS`'s `satisfies Record<keyof T, true>`
tether (CLAUDE.md, *Comment Discipline*) is what keeps the rename total.

---

## 7. Stop conditions

1. **The entry-layer overlap pre-flight (§1.4) returns rows.** The migration
   aborts; the resolution is a decision about those specific rows, never a
   weakening of the constraint.

   **Run it twice: once before writing the migration, and again inside the
   migration's own transaction.** Raised at spec review. The pre-flight in §1.4
   is a check on a moving target — 43 live rows in local dev make a class
   created between the check and the `ALTER` unlikely, but the failure mode is
   an aborted migration on a constraint that cannot be added `NOT VALID`
   (§7.2), so the cheap guard is worth its one `DO $$` block. The precedent is
   in-repo: `20260821120000_cross_family_slot_guard` opens with exactly such a
   block. Note the irony deliberately — that block is also what §1.3's
   migration-text grep mistook for two live enforcement predicates. A one-shot
   pre-flight is the right tool here and a false positive for any later audit,
   which is an argument for a comment on the block saying so, not against
   having it.
2. **`prisma migrate dev` offers `DROP COLUMN "span"`.** The generated column
   must be declared `Unsupported("tsrange")? @default(dbgenerated())` or the
   diff cascade-drops the exclusion constraint — stage A's lesson, and the first
   thing this repo put in the database that `schema.prisma` cannot describe.
3. **The dev server on :3000 predates the migration.** `next dev` hot-reloads
   route files but never reloads `node_modules/@prisma/client`, which is a
   `globalThis` singleton. This invalidated 97 test results for most of stage
   A's life. The server is the user's to restart; the branch must ask, and must
   not read integration results taken across the boundary.
4. **A red unit test hides the integration tier.** `npm test` joins two
   invocations with `&&`, so integration reports *nothing* — not zero failures —
   while anything earlier fails. Invoke
   `npx vitest run --project integration` directly until the unit tier is green.

**Measured baseline, 2026-08-25, `npm run verify` green (exit 0):**

| project | files | tests |
|---|---|---|
| unit | 64 | 961 |
| components | 45 | 296 |
| unit-sweeps | 10 | 122 |
| integration | 33 | 519 |
| **total** | **152** | **1898** |

`64 + 45 + 10 + 33 = 152` and `961 + 296 + 122 + 519 = 1898`; the two
invocations reconcile as `109 / 1257` and `43 / 641`. **Re-measure rather than
inheriting this** — stage A's inherited baseline was stale in structure, not
only in count.

---

## 8. Left out of stage B

Everything §9 of the parent spec leaves out, unchanged — `location` stays on
`StudioClass`, no buffer between classes, no totality constraint, and the
lifecycle triad merge does not land here. `pauseOrResume` and
`archiveOrUnarchive` are ready now that `ScheduleRule` exists; `update` is
blocked on #284.

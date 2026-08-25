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
§2.2(d) says.

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
- **No new cycle.** `updateClass` acquires at most one of the two rows
  implicitly, so it cannot hold one and wait for the other. Where a caller
  writes both in one transaction it must take them in `lockClassRow`'s order;
  that is the ordering rule to record in `docs/lock-order.md`.

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
- **The midnight spill makes it close to mandatory.** §4.3's new capability is
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

### 4.3 Decision: the entry carries its own freeze marker

`CalendarEntry` gains a nullable timestamp recording that this entry's schedule
is fixed because the class it belongs to reached a terminal state. Both guards
become **single-table triggers on `CalendarEntry`**, reading `OLD` on the very
row the statement is already locking.

The alternative — recreating the guard on `CalendarEntry` and having it read the
owning `Class.status` — was rejected on a measured property, not on taste. A
trigger's read runs in the statement's snapshot, so a concurrent *uncommitted*
completion is invisible to it: the trigger would see a non-terminal class,
allow the date to move, and the completion would then commit. §2's lock fix
closes that for every path through `lockClassRow`, but the triggers exist
*because they reach every client including raw SQL* — that is the reason the
reaper's docblock gives for being allowed to delete at all — so a guard that is
only as strong as the application's locking discipline is strictly weaker than
what it replaces.

A `BEFORE UPDATE` trigger reading its own row's `OLD` has no such window. **This
is stronger than today's arrangement, not merely equivalent**, and it removes
the cross-table read that #298 set out to eliminate rather than reintroducing
one.

The cost is a sync obligation on a denormalised column, and it is bounded: the
writers are the completion path and the two cancel paths (§5), all of which
already write in a transaction that holds the entry's lock under §2.

**What the marker is not.** It is not a general "is this row editable" flag. The
two families' editability rules genuinely differ and stay where they are: #276's
studio rule is date-derived (`date < teacher's today`), and the `Class` family's
is status-derived. The marker answers exactly the question the reaper needs —
*has the owning class reached a terminal state* — and the plan must state that
scope where the column is declared, because a wider-sounding name invites a
second meaning.

`TERMINAL_CLASS_STATUSES` and both pinning tests are re-pointed with it. The
tests keep their shape: derived constant compared against the new migrations'
SQL, two independent texts nothing else forces to agree.

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
§4.2 and §11 item 6).

---

## 6. Carried from the parent spec

§3 (target schema), §4.1–§4.5, §5.1–§5.2, §6 (`startTime → @db.Time`, wire
format stays `"HH:MM"`), §7.1 (the index census and the
`slot-constraints.test.ts` port, group by group), §7.2 (no grandfathering), §8
(issue consequences), §9 (left out), and §11 items 1, 3, 5, 6, 7.

**Carried with one correction, not unchanged.** §3's disjoint-occupancy
paragraph recorded the parent-`kind`-flip refusal as `23503`; it is `23514`,
from the child's `CHECK`, and §1.3.1 has the measurement and the stage-A test
that already pinned it. The parent spec has been corrected in place rather than
annotated, per CLAUDE.md's *Comment Discipline* — the before-and-after lives
here and in the PR body.

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

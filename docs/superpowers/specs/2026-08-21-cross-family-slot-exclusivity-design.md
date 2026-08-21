# Cross-family slot exclusivity: one teacher, one slot, two tables

Issue #296. Spun out of #275's triage, where the maintainer challenged the
premise that a free slot may depend on which family a class belongs to.

Related and deliberately separate: #297 (overlap by duration), #298 (the
structural question of how the two families should relate).

---

## 1. What the issue claimed, and what was measured

### 1.1 Held, exactly: the slot invariant is enforced four times, always per-table

`prisma/migrations/20260811202634_teacher_slot_unique_indexes/migration.sql`
declares four partial unique indexes: `Class_teacher_slot_unique` and
`StudioClass_teacher_slot_unique` on `(teacherId, date, startTime)`, and
`ClassTemplate_teacher_slot_unique` and `StudioClassTemplate_teacher_slot_unique`
on `(teacherId, dayOfWeek, startTime)`.

Two of those cover the same column set on two different tables. PostgreSQL
cannot express a cross-table unique index, so nothing spans them. This is not an
oversight in that migration — it is a constraint the chosen mechanism cannot
carry, and nothing was put in its place.

### 1.2 Held, and larger than the issue stated: the sweeps create the collision

Neither generator reads the other family:

- `generateStudioInstancesForTemplate` builds `occupants` from
  `db.studioClass` alone (`src/services/studio-class-generator.ts:147`)
- `generateInstancesForTemplate` from `db.class` alone
  (`src/services/class-generator.ts:281` and `:319`)

Grepped both directions for a cross-read: **zero hits**. So the hourly sweep
lays a studio class on top of a live regular class with no skip and no reason.
The issue described a teacher double-booking themselves; the machine does it
unprompted.

### 1.3 Held: the same hole exists at the template level

Both template indexes are per-table, so a `ClassTemplate` and a
`StudioClassTemplate` may both own Tuesday 19:00 indefinitely — after which the
two sweeps contend for that slot every week.

### 1.4 Measured: this checkout's data is clean

| Query | Count |
|---|---|
| Instance-level cross-family collisions | 0 |
| Template-level cross-family collisions | 0 |
| Live `Class` (`status <> 'cancelled'`) | 31 |
| Live `StudioClass` (`cancelledAt IS NULL`) | 8 |
| Unarchived `ClassTemplate` | 5 |
| Unarchived `StudioClassTemplate` | 1 |

Stated with its weakness: with **one** unarchived studio template in the
sample, the template check could have failed but was unlikely to by chance. It
is good evidence that no remediation is needed here, and weak evidence about
any other environment. The migration guards on it regardless (§5.1).

### 1.5 WRONG, and mine: the advisory-lock-in-trigger design

The design first recommended — and approved — had each trigger take
`pg_advisory_xact_lock` on the slot key before checking its sibling. Reading
`docs/lock-order.md` afterwards showed that instrument is wrong here, in three
independent ways:

- **#103 is the same shape, already lived through.** A RESTRICT trigger's
  implicit `FOR KEY SHARE` produced an AB-BA deadlock described as *"a lock
  nothing in this document's site enumeration can see, because no source line
  issues it"*. What closed it was **a guard in each delete route, not a lock**,
  and that document records that adding a `lock_timeout` node instead was
  *"considered and rejected"*.
- **The existing advisory lock's docblock names this design.** *"The thing to
  check is a second call site, not a reordering. Add one inside a transaction
  that already holds a `Class` row lock … and the inversion is immediate and
  will not announce itself."* A trigger on `Class` is not a second call site; it
  is every call site. And `pg_advisory_xact_lock` is transaction-scoped, so it
  is held from mid-statement to commit, across every later statement.
- **A shared reservation table would worsen the measured problem.** A
  vacate-and-claim on a slot key already deadlocks in **32 of 100 runs**, and
  the document is explicit that it *"has no order to take"*. A second unique key
  over the same tuple adds a second identical cycle.

The lock is therefore **removed from the design**. §4 carries the replacement
and the residual it accepts.

### 1.6 Corrected, and recorded in #275: a cancelled class holding its key is not a bug

Verified while triaging. The two-rule split the maintainer described is already
implemented and already tested:

- **Live-slot rule:** both slot indexes are partial on purpose. The migration
  says why — *"a cancelled class must not make its slot permanently unfillable,
  which is the bug a non-partial index would trade for the one being fixed."*
  Pinned at `src/services/slot-constraints.test.ts:113` and `:128`.
- **Generation rule:** cancelled rows keep their `(templateId, date)` key, so
  the generator declines to refill. Both generators encode this — the `own`
  branch ignores cancellation, the `slot_taken` branch filters to live rows.

This spec changes neither rule. Every existing test in
`slot-constraints.test.ts` must pass unedited.

---

## 2. The decision

Five choices, taken with the maintainer before this spec, with the sixth
recording the correction in §1.5.

1. **Slot definition:** exact `(teacherId, date, startTime)`, identical to what
   the four existing indexes already mean. Overlap by duration is #297.
2. **Scope:** both levels. Instance alone leaves a setup that can never fully
   generate — the same shape of silent defect being removed.
3. **Enforcement:** database triggers, not application discipline. A forgotten
   door is this repo's recurring failure (#146, #148, #79, #82); a schema-level
   guard is immune to it.
4. **Sweep reporting:** a sixth `SkipReason` with its own copy, because the
   remedy differs between "your own studio class holds this" and "your
   recurring class holds this".
5. **Sequencing:** this lands before #275, whose Restore door is unsafe in
   exactly the case this invariant governs.
6. **The triggers take no lock** (§1.5, §4).

---

## 3. What "live" means, and why it is spelled twice

The two families disagree on how liveness is expressed:

| Family | Live when |
|---|---|
| `Class` | `status <> 'cancelled'` |
| `StudioClass` | `cancelledAt IS NULL` |
| `ClassTemplate` | `isArchived = false` |
| `StudioClassTemplate` | `isArchived = false` |

Each trigger reads the **sibling's** spelling, not its own. This divergence is
the root cause #298 exists to decide; this spec works with it rather than
against it.

Note what is deliberately *not* included: `isActive` (paused). A paused
template goes on holding its slot, exactly as it does within its family today.
Changing that is out of scope and would be a behaviour change to the existing
indexes, not an extension of them.

---

## 4. Enforcement: the trigger, and the lock it deliberately does not take

### 4.1 A plain `SELECT`, no locking clause

Each trigger performs an unlocked read of the sibling table. It adds no node to
`docs/lock-order.md`'s ordering, takes nothing that is held to commit, and
cannot participate in a cycle it did not already participate in.

What it catches is the failure that actually recurs here: a write path that
nobody remembered to guard. That is worth more than closing a race, because a
forgotten door is permanent and a race is a coincidence.

### 4.2 The residual, and the obligation to measure it

An unlocked read under READ COMMITTED cannot see an uncommitted sibling insert.
Two transactions writing opposite tables at one slot may therefore both commit.

Structurally bounded already: `class-generation` runs
`isolatedSweeps('class-generation', [generateClassInstances,
generateStudioClassInstances])`, and `isolatedSweeps` is a `for…of` with
`await` (`src/lib/scheduler.ts:66-68`). **The two generators cannot run
concurrently**, so the machine-versus-machine pairing is impossible. What
remains is teacher-action-versus-sweep, or two teacher devices.

**This spec does not accept that residual on reasoning.** `docs/lock-order.md`
reproduced its own edges at 32/100 and 1/120, and contains two worked examples
of a concurrency claim that was argued rather than measured and was wrong —
one of them quoting evidence that disproved it. The residual is measured before
it is documented (§6.3). If it measures common, this section is reopened and
the advisory lock returns with a proper ordering section.

### 4.3 Rejected: a shared `TeacherSlot` table

Two forms, both rejected, recorded so neither is re-proposed:

- **Mirror** (slot table beside the existing columns): the same fact stored
  twice, so a trigger is needed to keep them in step. The table *and* the
  triggers, plus a second cycle on the vacate-and-claim crossing, plus #210
  going live as three unique keys share `(teacherId, date, startTime)`.
- **Owner** (slot table holds date and time; class tables lose them): no
  duplication, but its unique index cannot see liveness, which lives one table
  over — so "a cancelled class must not block its slot" stops being
  expressible. Resolving that means moving cancellation onto the slot, which is
  a schema-wide change. Filed as #298, not decided here.

---

## 5. Design

### 5.1 The migration

One hand-authored migration, following
`prisma/migrations/20260721061528_student_claim_link_check/`. It:

1. **Verifies before it guards.** Two `SELECT`s counting existing violations;
   `RAISE EXCEPTION` if either is non-zero, so no environment silently gets
   triggers over dirty data. (`prisma db execute` surfaces `RAISE EXCEPTION`
   and swallows `RAISE NOTICE`; use `psql` in `fairyoga-db-1` to see a success
   notice.)
2. Adds `@@index([teacherId, date])` to `StudioClass` — **#205, folded in**,
   because the Class-to-StudioClass lookup would otherwise scan. `Class`
   already carries the equivalent at `prisma/schema.prisma:438`.
3. Creates four trigger functions and eight trigger declarations (§5.2).

Triggers are invisible to `prisma migrate diff`, exactly as the partial indexes
are, so this reads as no drift in CI. All four models already carry a docblock naming the partial index Prisma
cannot show (`prisma/schema.prisma:314`, `:379`, `:442`, `:510` — one per
model). That convention is extended to name the triggers, so the invariant
stays visible to a reader of `schema.prisma`.

### 5.2 Four functions, eight declarations

**Two declarations per table, not one.** PostgreSQL's `WHEN` clause may not
reference `OLD` on an INSERT trigger, so a combined `BEFORE INSERT OR UPDATE`
declaration carrying the "did the slot actually move" predicate is invalid.
Each table gets a `BEFORE INSERT` and a `BEFORE UPDATE` declaration sharing one
function.

Shape, for `Class` (the other three mirror it, swapping the sibling table and
its liveness spelling per §3):

```sql
CREATE OR REPLACE FUNCTION class_reject_cross_family_slot()
RETURNS TRIGGER AS $$
DECLARE conflicting text;
BEGIN
  SELECT id INTO conflicting
  FROM "StudioClass"
  WHERE "teacherId" = NEW."teacherId"
    AND "date"      = NEW."date"
    AND "startTime" = NEW."startTime"
    AND "cancelledAt" IS NULL
  LIMIT 1;

  IF conflicting IS NOT NULL THEN
    RAISE EXCEPTION
      'Teacher % already has a live studio class (%) at % %',
      NEW."teacherId", conflicting, NEW."date", NEW."startTime"
      USING ERRCODE = 'YG001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER class_cross_family_slot_insert_guard
  BEFORE INSERT ON "Class"
  FOR EACH ROW
  WHEN (NEW."status" <> 'cancelled')
  EXECUTE FUNCTION class_reject_cross_family_slot();

CREATE TRIGGER class_cross_family_slot_update_guard
  BEFORE UPDATE ON "Class"
  FOR EACH ROW
  WHEN (
    NEW."status" <> 'cancelled'
    AND (
         OLD."status"    =  'cancelled'
      OR OLD."date"      IS DISTINCT FROM NEW."date"
      OR OLD."startTime" IS DISTINCT FROM NEW."startTime"
      OR OLD."teacherId" IS DISTINCT FROM NEW."teacherId"
    )
  )
  EXECUTE FUNCTION class_reject_cross_family_slot();
```

**The UPDATE `WHEN` is narrow on purpose.** It fires only when the row is live
*and* the slot moved or the row became live. Two consequences, both wanted:

- An unrelated update to a live class — `spotBroadcastAt`, the completion
  totals, `settingsLocked` — does not pay for a sibling lookup.
- A pre-existing violating pair stays editable for every field except the ones
  that would move it into the slot. Freezing both rows is the failure mode #76
  was filed about, and it is avoidable for free.

Template triggers use `NEW."isArchived" = false` with
`OLD."isArchived" = true` in place of the cancelled-to-live term, which is what
makes **unarchiving** a template subject to the guard.

### 5.3 The error, and how the application sees it

`ERRCODE = 'YG001'`, a user-defined SQLSTATE. Deliberately **not** `23505`:
Prisma maps that to P2002 with no `meta.target`, so `isUniqueConflictOn` — which
requires `target` to be an array — returns false and the request falls through
to a 500. That failure looks like success in review and must not be built.

Deliberately not `23514` either, which the existing
`class_reject_terminal_date_change` already uses; two triggers sharing a
SQLSTATE cannot be told apart by the code that maps them.

A sibling helper beside `src/lib/unique-conflict.ts` matches it. Precedent for
the technique is already in the repo: `isTransientError`
(`src/lib/api-errors.ts:220-227`) matches SQLSTATEs by string inside Prisma's
message text, because *"two different error shapes carry the same SQLSTATE, and
both were measured against this project's own database rather than assumed"*.

**The helper's docblock pins a measured error shape, not an asserted one** — the
discipline `unique-conflict.ts` used when it recorded its own `meta.target`
measurement. The measurement is a plan step, and its output is pasted into the
docblock.

### 5.4 Route catches and generator pre-checks — two mechanisms, not one

The trigger enforces. What the application adds differs by caller, and
conflating the two is a mistake this spec made in an earlier draft:

- **Routes catch.** A route's only job is to turn the guard's error into copy a
  teacher can act on. A pre-emptive query would buy nothing — unlike #103,
  where the pre-check existed to avoid a deadlock, not to phrase an error.
- **Generators pre-check.** A generator must classify a blocked date and
  *continue* with the others, so it has to know before it writes. This is the
  idiom `src/services/studio-class-generator.ts:173` already states (twin at
  `src/services/class-generator.ts:381`): *"this pre-check is what names the
  reason, not what enforces it."*

Paths, and which mechanism each takes:

| Path | Mechanism | Why |
|---|---|---|
| `POST /api/classes` | catch | new slot |
| `POST /api/studio-classes` | catch | new slot |
| `PUT /api/classes/[id]` | catch | `date` / `startTime` edit |
| `PUT /api/studio-classes/[id]` | catch | `startTime` edit **and** the `cancelledAt: null` clear — the #275 link |
| `POST /api/class-templates` | catch | new template slot |
| `POST /api/studio-class-templates` | catch | new template slot |
| `PUT` on both template routes | catch | `dayOfWeek` / `startTime` edit |
| both archive/unarchive paths | catch | unarchiving re-enters the template key exactly as un-cancelling re-enters the instance key |
| both generators | **pre-check** | must classify and continue, via the new `SkipReason` (§5.5) |

Copy is user-facing prose, not a developer string (#197 is open about eighteen
that are not). It names the other family: *"You already have a class at that
date and time."* / *"You already have a studio class at that date and time."*

### 5.5 The sixth `SkipReason`

`SkipReason` (`src/lib/generation.ts:47`) gains a member beside
`already_generated`, `blocked_by_cancelled`, `slot_taken`, `already_this_week`
and `raced`.

Reusing `slot_taken` was considered and rejected: one member would then carry
two situations with different remedies, which is the conflation #288 is open
about.

`countSkipReasons` is the single place they reduce, and its docblock already
makes a new member fail the build rather than vanish. `SkipCounts` is
hand-listed in the studio resume result — **#291** — so this change touches that
hand-list. Whether to fix #291 here or work around it is a planning decision;
the spec requires only that the hand-list not be left silently short.

Copy belongs in `src/components/settings/template-action-messages.ts`. Follow
that file's existing discipline: `resumeStudioMessage` delegates to
`resumeMessage` where the sentences are identical, with a test pinning that they
agree. If the two families' sentences differ here — they do, because each names
the *other* family — they are written separately and the difference is the
point.

### 5.6 The generator's batch insert

`createManyAndReturn({ skipDuplicates: true })` absorbs a within-family unique
violation silently. **It cannot absorb a raised exception** — that aborts the
whole statement, so one cross-family collision would cost all four dates.

Design: keep the batch. On `YG001`, fall back to inserting the free dates one at
a time, classifying the loser as the existing `'raced'`. The pre-check makes
this rare, per-template failure isolation (#55) bounds it, and the next hourly
sweep recovers regardless.

### 5.7 `docs/lock-order.md`

The trigger issues a `SELECT` on the sibling table that no source line issues —
the precise thing #103 proved invisible. A new section describes it, in the
register of *"The RESTRICT trigger is a wait edge"*. This is a deliverable, not
documentation garnish: the next person adding a lock near `Class` needs to find
this without rediscovering it.

---

## 6. Testing

### 6.1 Integration — `src/services/slot-constraints.test.ts`

Extends the existing file, which already covers the within-family cases. New
cases, per level and per direction:

- a live `Class` rejects a live `StudioClass` at the same teacher/date/startTime
- and the reverse
- a **cancelled** `Class` does not block a live `StudioClass`, and the reverse
- a live `ClassTemplate` rejects a live `StudioClassTemplate` on the same
  teacher/dayOfWeek/startTime, and the reverse
- an **archived** template does not block the sibling family's template
- **unarchiving** a template into an occupied cross-family slot is rejected
- another teacher at the same date and time is unaffected, all four directions
- a live class's unrelated column may be updated while a cross-family violation
  pre-exists (the #76 guard)

Every existing case in that file must pass **unedited**. An edit to one is a
signal the within-family rules moved, which this spec forbids.

### 6.2 Mutations — each guard broken, error recorded, restored, re-verified

| Mutation | Must turn red |
|---|---|
| Trigger function queries its own table instead of the sibling | cross-family rejection, all four directions |
| Drop the liveness predicate from the trigger's `SELECT` | "a cancelled/archived row does not block" |
| Widen the UPDATE `WHEN` to fire on any update | "a pre-existing violating pair stays editable" |
| Drop the `BEFORE INSERT` declaration, keep `BEFORE UPDATE` | the create-route cases |
| Drop the `BEFORE UPDATE` declaration, keep `BEFORE INSERT` | the un-cancel and unarchive cases |
| Change `ERRCODE` to `23505` | the 409-mapping test — proves §5.3's reasoning rather than asserting it |
| Remove a **route's** catch | that route's copy assertion — the status also moves (409 to 500), so this one is visible either way |
| Remove a **generator's** cross-family pre-check | the skip-reason assertion, and **nothing else**. The trigger still fires, the batch still aborts, and §5.6's fallback silently reclassifies the date as `'raced'` — so the created count is unchanged and only the reason moves. This is the #103 shape exactly: a guard whose removal is masked by the fallback beneath it. Assert the reason, never the count |

That last row is the one to get right. It is the exact defect #103 shipped past
review, and a status-code assertion cannot see it.

### 6.3 The residual reproduction

Method as `docs/lock-order.md` used: a throwaway database with the full
migration history, the real functions, raced as-is, no handshake. Two
transactions writing opposite tables at one slot, N runs, count the double
bookings.

The number is recorded in the spec, the PR body, and the `known-open` comment.
If it is high, §4.2 is reopened rather than documented around.

Warm the routes first if any part of this runs through HTTP — `next dev`
recompiles lazily and the first request can blow a timeout in a way that reads
as an assertion failure (#290).

### 6.4 Component and unit

- `template-action-messages` gains a case for the new reason's sentence.
- The new error-matching helper gets unit tests, including a negative case
  proving it does **not** match `23514` (the terminal-date trigger's code).

---

## 7. Documentation

- `docs/lock-order.md` — the new wait-edge section (§5.7).
- `CLAUDE.md` — a Class Lifecycle bullet stating the cross-family rule and that
  cancelled/archived rows do not participate.
- `prisma/schema.prisma` — docblocks on all four models naming the triggers,
  since `migrate diff` cannot see them.
- Issue updates: #205 marked absorbed; #275 already carries the sequencing
  note; #291 updated with whatever the plan decides about the hand-list.

---

## 8. What this spec does not do

- **Overlap by duration.** #297. This extends exact-start matching; it does not
  redefine a slot.
- **#275's Restore door.** The follow-up, which lands on this.
- **The structural question.** #298. The triggers here are deleted on the day it
  is decided in favour of an extraction, and nothing done here is wasted.
- **#288.** Its overlapping-predicate problem is not resolved, only not worsened.
- **`isActive` (paused) semantics.** Unchanged (§3).
- **The 32-of-100 vacate-and-claim deadlock.** Pre-existing, documented in
  `docs/lock-order.md` as having no order to take, and untouched by this work.

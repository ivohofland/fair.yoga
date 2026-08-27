# An active template may not sit on an archived room — enforced once, in Postgres

Issue 272. Filed as a decision; this spec picks **Option A**, in the declarative
form the codebase already uses twice, and records what was measured rather than
what the issue assumed.

Date: 2026-08-27. Measured against `ethical_yoga`, `ethical_yoga_test`, and two
throwaway databases (`probe272_drift`, `probe272_real`) built from the migration
history and from a copy of `ethical_yoga_test`. Both throwaways were dropped;
neither real database was written to.

---

## 1. What the issue said, and what measurement changed

The issue was measured on 2026-08-20, on `fix/116-resume-cas-claim`. Issues
#296, #298, #327 and #332 have landed since. Four of its claims were re-checked.

**Held.** *"Nothing in Postgres enforces it."* The schema carries fifteen
triggers and none names `TeacherRoom`; the only migrations mentioning the table
are the ones that create its columns. Re-derive:

```sh
grep -rh "CREATE TRIGGER" prisma/migrations/*/migration.sql | sort -u
```

**Held.** *"Every door is a non-transactional read."* All of them read on `db` /
`prisma` and write in a later statement or transaction. Under READ COMMITTED
none of those reads holds anything.

**Corrected — door 4 is not a service.** The issue's table gives "template
create" with no site. It is `src/app/api/class-templates/route.ts`, above the
`createClassTemplate` call; the service itself never reads `isArchived`. Four
service doors and one route door, not five service doors. `room-archive.ts`'s
own header already had this right, and names the doors by verb rather than
counting them — *"because the count is what went stale: this sentence said
'three' until fix round 2 added a fourth."*

**Corrected — door 2 enforces a different invariant.** The issue counts five
doors for *"an active `ClassTemplate` may not reference an archived
`TeacherRoom`"*. Door 2 (`class-lifecycle.ts`) refuses publishing a **`Class`**
into an archived room — a different rule about a different table. There are two
sibling invariants:

| | Template invariant | Class invariant |
|---|---|---|
| Statement | an active `ClassTemplate` may not reference an archived `TeacherRoom` | a `Class` may not be published into an archived `TeacherRoom` |
| Doors | 3, 4, 5, and door 1's `templates` count | 2, and door 1's `classes` count |

Only door 1 guards both. **This spec fixes the template invariant. The class
invariant is untouched and remains racy**, filed separately (§8).

**Corrected — Option A is not a trigger pair.** #298 moved `isActive` and
`isArchived` to `ScheduleRule` while `teacherRoomId` stayed on `ClassTemplate`.
The predicate now spans three tables:

```
ScheduleRule.isActive AND NOT ScheduleRule.isArchived   -- "the rule is live"
  ×  ClassTemplate.teacherRoomId                         -- "which room"
  ×  TeacherRoom.isArchived                              -- "is it shelved"
```

The issue's "trigger pair" would be a trigger trio, each joining across.

**Confirmed rather than assumed — there are no violating rows.** The issue says
"probably empty — confirm rather than assume":

```sql
SELECT count(*) FROM "ClassTemplate" ct
  JOIN "ScheduleRule" sr ON sr.id = ct."scheduleRuleId"
  JOIN "TeacherRoom"  tr ON tr.id = ct."teacherRoomId"
 WHERE sr."isActive" AND NOT sr."isArchived" AND tr."isArchived";
```

`0` in both `ethical_yoga` and `ethical_yoga_test`. Neither database holds a
single archived room. The migration needs no remediation step — but it must
still fail loudly if one appears, and it will: adding the CHECK to a table
holding a violating row errors with *"check constraint … is violated by some
row"*, observed during the probe.

---

## 2. The decision, and why not a trigger

`docs/lock-order.md` records that both halves of the teacher-slot invariant
**used to be** trigger functions running a plain `SELECT … LIMIT 1` against the
sibling table, raising a user-defined SQLSTATE. #298 and #327 replaced them with
`EXCLUDE USING gist` constraints, *"index-backed and therefore race-free by
construction"*. Option A as written reintroduces exactly the pattern those
issues removed, and its own open sub-question — *"whether the triggers take row
locks"* — is the question that mechanism exists to avoid.

The declarative equivalent for a join predicate is not an exclusion constraint
(which sees one table) or a CHECK (which sees one row). It is a **composite
foreign key to a non-primary-key unique**, which is already how every child of
the two shared-identity tables reaches its parent — each of `ClassTemplate` and
`StudioClassTemplate` through `(scheduleRuleId, kind) → ScheduleRule(id, kind)`,
each of `Class` and `StudioClass` through
`(calendarEntryId, kind) → CalendarEntry(id, kind)`. The difference here is that
the mirrored column is **mutable** where `kind` is a literal, so the mechanism
needs `ON UPDATE CASCADE` to carry parent changes down. That it does so —
including from a `GENERATED ALWAYS … STORED` column — is measured, not assumed
(§4).

**Option B (cascade on archive) was rejected at the direction gate.** Archiving
stays a refusal, which is what keeps the invariant a genuine invariant and
therefore expressible as a constraint. A "archive anyway, and pause the N
templates that block it" affordance is a real product improvement and is filed
separately (§8) rather than folded in.

**Option C (accept and instrument) was rejected** on the ground the issue
already states: `room-archive.ts` accepted this race class for one stray `open`
class, whereas here the hourly sweep manufactures new classes into the shelved
room indefinitely.

---

## 3. The mechanism

Three parent keys, two mirrored columns, one CHECK. No trigger, no new
hand-written lock acquisition.

```sql
-- Parent keys the mirrors point at.
ALTER TABLE "TeacherRoom"
  ADD CONSTRAINT "TeacherRoom_id_isArchived_key" UNIQUE ("id", "isArchived");

ALTER TABLE "ScheduleRule"
  ADD COLUMN "live" BOOLEAN GENERATED ALWAYS AS ("isActive" AND NOT "isArchived") STORED;
ALTER TABLE "ScheduleRule" ALTER COLUMN "live" SET NOT NULL;   -- REQUIRED: see section 4
ALTER TABLE "ScheduleRule"
  ADD CONSTRAINT "ScheduleRule_id_kind_live_key" UNIQUE ("id", "kind", "live");

-- The mirrors, backfilled from the parents they mirror.
ALTER TABLE "ClassTemplate" ADD COLUMN "ruleLive"     BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClassTemplate" ADD COLUMN "roomArchived" BOOLEAN NOT NULL DEFAULT false;
UPDATE "ClassTemplate" ct SET "ruleLive"     = sr."live"
  FROM "ScheduleRule" sr WHERE sr.id = ct."scheduleRuleId";
UPDATE "ClassTemplate" ct SET "roomArchived" = tr."isArchived"
  FROM "TeacherRoom"  tr WHERE tr.id = ct."teacherRoomId";

-- The two EXISTING foreign keys, widened to carry the mirrored column.
-- Referential actions are preserved exactly; nothing about delete behaviour changes.
ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_scheduleRuleId_kind_fkey";
ALTER TABLE "ClassTemplate" ADD  CONSTRAINT "ClassTemplate_scheduleRuleId_kind_ruleLive_fkey"
  FOREIGN KEY ("scheduleRuleId", "kind", "ruleLive")
  REFERENCES "ScheduleRule"("id", "kind", "live") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "ClassTemplate" DROP CONSTRAINT "ClassTemplate_teacherRoomId_fkey";
ALTER TABLE "ClassTemplate" ADD  CONSTRAINT "ClassTemplate_teacherRoomId_roomArchived_fkey"
  FOREIGN KEY ("teacherRoomId", "roomArchived")
  REFERENCES "TeacherRoom"("id", "isArchived") ON UPDATE CASCADE ON DELETE RESTRICT;

-- The invariant itself.
ALTER TABLE "ClassTemplate" ADD CONSTRAINT "ClassTemplate_live_needs_open_room"
  CHECK (NOT ("ruleLive" AND "roomArchived"));
```

Widening the two foreign keys that already exist, rather than adding two new
ones, is deliberate: Prisma models them as `@relation`s, so the datamodel can
declare the whole shape and the drift check stays green (§4).

### Why each write is now refused

| Write | What happens |
|---|---|
| archive a room under a live template | cascade sets `roomArchived := true` on a row with `ruleLive = true` → `23514` |
| archive a room under a paused template | cascade sets `roomArchived := true`, `ruleLive` is false → succeeds, as it must |
| resume a rule whose room is archived | `live` flips, cascade sets `ruleLive := true` on a row with `roomArchived = true` → `23514` |
| create an active template on an archived room | the insert asserts `(roomArchived = false)` against an archived parent → `23503`; asserting `true` → `23514` |
| move a live template onto an archived room | as create → `23514` |
| write a mirror that disagrees with its parent | no matching parent key → `23503` |

The last row is the load-bearing one: **the mirrors cannot lie.** That is what
makes it safe to check a three-table predicate against a single row.

---

## 4. Evidence

Every claim below was produced by running it. Commands are given so a reviewer
can re-derive rather than trust.

### 4.1 The doors, on the real schema with real data

A copy of `ethical_yoga_test` (32 templates, 1013 rooms), migrated with §3, then
each door driven inside one `DO` block with caught exceptions so that every
result is attributed to the statement that produced it:

```
DOOR 1   archive under a LIVE template    : refused 23514
DOOR 1b  archive under a PAUSED template  : succeeded (correct)
DOOR 3   resume onto an archived room     : refused 23514
DOOR 4   create a LIVE template on shelved: refused 23514
DOOR 5   move a LIVE template to shelved  : refused 23514
TAMPER   deny the room is archived        : refused 23503 (FK, not CHECK)
```

`DOOR 1b` is not decoration. It is the case that must keep working — a teacher
must still be able to pause a template and then archive its room — and an
over-broad constraint would break it. An earlier run of this probe used
`CREATE TEMP VIEW … LIMIT 1` to pick the target row; because a view re-evaluates
on every reference, the "target" changed under the updates and the results could
not be attributed. That run was discarded, not interpreted.

### 4.2 The race, with proof the windows overlapped

The interleaving the issue measured leaking — a room archiving between door 3's
read and its write:

```
A resumed at   19:30:31.176      (transaction opens, rule isActive false → true)
B attempts at  19:30:33.210      ← 2.0s inside A's open transaction
A commits at   19:30:37.190
B refused at   19:30:37.193      ← 2.9ms after A's commit, SQLSTATE 23514
```

B **blocked for 3.98 seconds** on A's row lock, then was refused on re-evaluation.
This is the same mechanism `docs/lock-order.md` describes for the exclusion
constraints — the second writer waits on the first and is refused once it
commits — with a row lock in place of an index entry, and `23514` in place of
`23P01`.

**The probe can fail.** Dropping only `ClassTemplate_live_needs_open_room` and
re-running the identical script:

```
B SUCCEEDED at 19:30:57.266 <-- INVARIANT BROKEN
```

which is issue 272 reproduced. Restoring the constraint afterwards then failed
with *"check constraint … is violated by some row"* — the same error a migration
would raise against pre-existing violating data.

### 4.3 The required CI check

`.github/workflows/ci.yml`, step *"Check schema/migration drift"*:

```sh
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                        --to-schema-datamodel  prisma/schema.prisma --exit-code
```

This is the check to test, **not** `prisma migrate dev` and **not**
`prisma migrate status`: status compares migration *names* and is structurally
incapable of seeing a column the datamodel cannot express. Measured against a
throwaway database built by `prisma migrate deploy` over the real history:

| State | Exit |
|---|---|
| baseline, unmodified schema | `0` — "No difference detected" |
| §3 applied, schema not yet declaring it | `2` — reports every added column, key and FK |
| §3 applied, schema declaring it, `live` still nullable | `2` — *"Altered column `live` (changed from Nullable to Required)"* |
| §3 applied incl. `SET NOT NULL`, schema declaring it | **`0` — "No difference detected"** |

The third row is why `ALTER COLUMN "live" SET NOT NULL` is in §3 rather than
left implicit: a `GENERATED ALWAYS` column is nullable unless told otherwise,
and Prisma's `Boolean` is required. Without that line CI fails. The second row
is the control: the check demonstrably distinguishes, so the final `0` is a
measurement rather than a vacuous pass.

`npx prisma validate` accepts the declared schema.

### 4.4 Lock edges

The foreign keys acquire locks that no application code asks for. This design
avoids *hand-written* `FOR UPDATE` acquisition; it does **not** avoid
lock-ordering work, and reading it as doing so is the error to guard against.
The implicit edges are real:

- updating `TeacherRoom.isArchived` locks every `ClassTemplate` row that
  mirrors it (`TeacherRoom → ClassTemplate`)
- updating `ClassTemplate.teacherRoomId` / `roomArchived` takes `KEY SHARE` on
  the referenced `TeacherRoom` row (`ClassTemplate → TeacherRoom`)

The crossed case was driven: T1 moved a template to room B and then archived
room A, while T2 archived room B. T2 blocked on T1's `KEY SHARE`, and on T1's
commit was refused with `23514` — correct, and no deadlock. A cycle still
requires two transactions touching two rooms in opposite orders, which is a
pre-existing shape rather than one this change introduces. **`docs/lock-order.md`
gains a section for these edges**, and the plan carries an explicit deadlock
probe as a task.

---

## 5. The docblock, written now

Written before the migration deliberately. The hazard this design carries is not
a bug — it is that `ruleLive` reads as `isActive` coming back to `ClassTemplate`
one issue after #298 moved it off, and a reader who concludes that will "tidy"
it. That misreading is a *description*, not a name, so no keyword sweep finds
it; the only defence is that the correct reading is written down where the
columns are.

On the two columns in `prisma/schema.prisma`:

```
/// MIRRORS, MAINTAINED BY POSTGRES. Neither column is state this row owns.
///
/// `ruleLive` mirrors `ScheduleRule.live`; `roomArchived` mirrors
/// `TeacherRoom.isArchived`. Neither can drift from what it mirrors, and that
/// is enforced rather than intended: each is one column of a composite foreign
/// key whose remaining columns are the parent's key, so a row claiming a value
/// its parent does not hold is refused with `23503` instead of stored, and
/// `ON UPDATE CASCADE` rewrites every mirroring child in the same statement
/// that changes the parent.
///
/// They exist so a predicate spanning three tables can be checked against one
/// row. That check is `ClassTemplate_live_needs_open_room`,
/// `CHECK (NOT ("ruleLive" AND "roomArchived"))`, hand-authored in the
/// migration because Prisma cannot express it — the constraint that makes "an
/// active template may not sit on an archived room" unrepresentable rather
/// than merely guarded (issue 272).
///
/// THIS IS NOT #298 BEING UNDONE. #298 moved the OWNERSHIP of `isActive` and
/// `isArchived` to `ScheduleRule`, and that is still the only place either is
/// written. What sits here is a copy the database maintains. Removing these
/// columns to "finish" #298 removes the invariant with them.
```

On `ScheduleRule.live`:

```
/// Rule liveness as a stored generated column: exactly the predicate
/// `ACTIVE_TEMPLATE_WHERE` (`src/lib/template-selection.ts`) applies to a row
/// set, computed per row so a foreign key can reference it.
///
/// `NOT NULL` is load-bearing and not tidiness. A generated column is nullable
/// unless declared otherwise, Prisma's `Boolean` is required, and the mismatch
/// is drift — `prisma migrate diff --exit-code`, the required CI check, fails
/// on it. `docs/lock-order.md` carries the argument for the constraint this
/// column serves.
```

Both obey CLAUDE.md's comment discipline: each annotates the code it sits on,
neither states a count or a roster, and the one cross-file claim each makes is a
pointer to a named object rather than a description of another module's
contents.

---

## 6. What happens to the application doors, and to #336

The constraint is the enforcement. The doors stay as **pre-checks that produce
the sentence a teacher reads** — which is the house pattern, not a compromise:
the teacher-slot invariant runs an `EXCLUDE` constraint underneath, a shared
`probeConflictingEntry` helper for the message, and the 409 translation in the
routes.

Following that pattern here means the room pre-check moves **out of the service
result unions and into the routes**. That is what fires #336, whose blocker is
mechanical:

```sh
diff <(sed -n '/^export type PauseTemplateResult/,/^$/p'       src/services/class-template-lifecycle.ts \
        | grep -oE "reason: '[a-z_]+'" | sort -u) \
     <(sed -n '/^export type PauseStudioTemplateResult/,/^$/p' src/services/studio-class-template-lifecycle.ts \
        | grep -oE "reason: '[a-z_]+'" | sort -u)
```

Today it emits exactly `reason: 'room_archived'`. #336 states the consequence
slightly too simply — *"enforcing it once in Postgres removes the application
doors, `room_archived` leaves `PauseTemplateResult`"* — because a constraint
still raises a SQLSTATE that something must translate. If the class family
catches `23514` and returns `reason: 'room_archived'`, the unions do **not**
converge and #336 stays blocked. **This spec therefore requires the translation
to live in the route**, so `PauseTemplateResult` loses the arm. Whether #336 is
then executed is its own issue's business; this spec's obligation is to run the
`diff` above at the end and record what it emits.

The `known-open` markers and the `LATENT / REACHABLE` note that #272's
acceptance criteria name (`class-generator.ts`, and door 3's marker in
`class-template-lifecycle.ts`) are removed and replaced by a pointer to the
constraint.

---

## 7. Open sub-choices for the plan

**7.1 Generated column, or three mirrored columns?** §3 mirrors
`ScheduleRule.live`, one derived concept. The alternative references
`(id, kind, isActive, isArchived)` directly and mirrors both flags — no
generated column, no Prisma unknowns, at the cost of a third mirrored column and
a CHECK reading `NOT ("ruleIsActive" AND NOT "ruleIsArchived" AND
"roomArchived")`. §3's form is measured green against the required check and is
the recommendation; the fallback exists if 7.2 turns out worse than expected.

**7.2 Prisma exposes `live` as writable.** Prisma has no generated-column
concept, so `live` appears in `ScheduleRuleUpdateInput`. Writing it fails at
runtime (`428C9`, "cannot insert a non-DEFAULT value into a generated column") —
loud, but a compile-time refusal would be better. `prisma generate` could not be
run against the throwaway schema during this spike (it attempted an `npm i` in
the scratch output directory and failed), so the exact client shape is
**unverified** and the plan must verify it rather than inherit this paragraph.
No code writes `live` today because it does not exist yet.

**7.3 `ClassTemplate.teacherRoomId` is not indexed.** Only the foreign key
exists; PostgreSQL does not index the referencing side automatically. Archiving
a room must now find every mirroring template, so the plan should measure
whether an index is warranted rather than adding one on principle.

---

## 8. Scope

**This spec covers the template invariant only.** The class invariant — door 2,
and door 1's `classes` count — is unaffected by this work and remains enforced
by non-transactional reads. The same mechanism would apply to `Class` (it
already carries `teacherRoomId`, and `status` plus the entry's `cancelledAt`
give liveness), and that is filed as a follow-up rather than folded in here.

Also filed rather than built: the *"archive anyway, and pause the templates that
block it"* affordance considered and set aside at the direction gate (§2).

Neither issue is closed by this work; both are recorded so they are leaves
someone can pick up rather than rediscoveries.

---

## 9. Acceptance

1. The migration applies to a database built from the real history, and to a
   copy of `ethical_yoga_test` carrying real rows.
2. `npx prisma migrate diff … --exit-code` exits `0`, demonstrated alongside a
   deliberately-broken variant that exits `2`.
3. Each of doors 1, 3, 4, 5 is refused, **and** door 1b succeeds, in tests that
   drive the database rather than the service.
4. The concurrent race in §4.2 lands as a passing test, with its negative
   control recorded in the PR body — this is issue 272's own acceptance
   criterion ("the reproduction above becomes a passing test").
5. Every guard is mutation-tested: dropping the CHECK reddens the door tests;
   dropping `SET NOT NULL` reddens the drift check; narrowing the FK to
   `(teacherRoomId)` reddens the tamper test. Each mutation's exact error text
   is recorded, and each is restored and re-verified.
6. The `known-open` markers and the `LATENT / REACHABLE` note are removed or
   re-pointed (§6).
7. `docs/lock-order.md` gains the §4.4 edges.
8. The #336 `diff` is run at the end and its output recorded, whatever it says.
9. `npm run verify` is green before the push.

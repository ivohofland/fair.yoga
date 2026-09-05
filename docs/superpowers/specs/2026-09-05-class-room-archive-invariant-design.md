# The class half of the room-archive invariant, made a constraint

Issue 339. Sibling to issue 272, whose spec is
`2026-08-27-template-room-archive-invariant-design.md` and whose §8 scoped this
half out explicitly.

The invariant: **a live `Class` may not sit in an archived `TeacherRoom`.**
Liveness is `status IN ('open','in_progress')` **and** the entry's
`cancelledAt IS NULL`.

---

## 1. What the issue said, and what measurement changed

Measured 2026-09-05 against `82d83fab`, in a worktree off `origin/main`.

Everything the issue asserts about the two remaining doors holds:

| Claim | Evidence |
|---|---|
| Door 2 reads the room outside the transaction | `class-lifecycle.ts:401` `findUnique` selecting `teacherRoom.isArchived`; the test at `:431` |
| Door 2's CAS carries no room predicate | `class-lifecycle.ts:529-536` — `status` and `calendarEntry.cancelledAt`, nothing else |
| Door 1 counts before writing | `room-archive.ts:148-156` counts; `:237` writes |
| `BLOCKING_CLASS_STATUSES` is `['open','in_progress']`, `draft` deliberate | `room-archive.ts:34-48` |
| #272's parent key exists | `schema.prisma:333`, `@@unique([id, isArchived])` |
| `isCheckViolationOn` exists | `src/lib/check-violation.ts` |

Four things the issue did not have right, or did not have at all.

### 1.1 The "generated column on `Class`" shape does not exist

The issue offers two shapes to compare and calls this "the part to spike
first": mirror the entry's `cancelledAt` down onto `Class`, **or** "a generated
column on `Class` if liveness can be derived from columns it already holds."

The second is not available, and no spike is needed to find that out. A
PostgreSQL `GENERATED ALWAYS AS (…) STORED` expression may reference only
columns of its own row. #327 moved cancellation off `Class` and onto
`CalendarEntry`, so no expression over `Class`'s own columns can see it. The
comparison has one surviving candidate.

The related trap is worth stating because #272's shape invites it: #272 made
`ScheduleRule.live` a *generated column* only because a **foreign key** had to
point at it, and a foreign key needs a real referenced column. Nothing points
at a `Class`'s liveness, so `Class` needs no generated column — the CHECK is an
expression over `status` and the two mirrors.

### 1.2 There is no `Class` "move" door

`updateClassSchema` (`schemas.ts:390-411`) is `.strict()` and has no
`teacherRoomId`. A class cannot change rooms after creation. The only writer of
`Class.teacherRoomId` in `src/` is the create at `api/classes/route.ts:131`.

Re-derive:

    grep -rn "teacherRoomId" --include="*.ts" src/ | grep -v '\.test\.' \
      | grep -v 'template\|room-archive\|room-deletion\|api/rooms'

#272 had a move door (`PUT /api/class-templates/[id]`, a template moved onto an
archived room). This issue has no counterpart, and the missing door is why the
class side has two doors where the template side had four.

### 1.3 `POST /api/classes` is not a door

It creates `status: 'draft'` (`api/classes/route.ts:141`). A draft may legally
sit on an archived room — that is the same asymmetry door 2's own comment
states, and the reason door 1 lets a draft-only room be archived.

### 1.4 The generator is not a third door, and the reason belongs on the record

`class-generator.ts:48-62` creates classes with `status: 'open'` directly. That
is a live class in whatever room its template names, written by a path with no
room check of its own — so it looks like a door, and is not.

Its safety is **derived from #272 rather than owned here**. A template on an
archived room is forced `ruleLive = false` by
`ClassTemplate_live_needs_open_room`, so `ACTIVE_TEMPLATE_WHERE` cannot select
it. The window between selection and insert is closed by a lock:
`claimTemplateForGeneration`'s row lock is held across `createChildren` (one
transaction per template, `class-generator.ts:161-172`), and
`setTeacherRoomArchived` pre-locks the same rows
(`room-archive.ts:231-236`, `WHERE ct."teacherRoomId" = $1 FOR UPDATE`, which
covers every template on that room).

This is recorded because it is load-bearing and invisible: it means the new
CHECK adds no obligation to the generator, and it means anyone who later
weakens #272's constraint reopens a path that this spec's constraint would then
refuse with an unhandled `23514`.

---

## 2. The decision

Mirror both parents down onto `Class` and let one CHECK carry the invariant —
#272's mechanism, one table further. Not a trigger, for the reasons #272's §2
gives and which are unchanged here.

Two decisions were taken at the direction gate rather than assumed.

### 2.1 Remediation: un-archive the room

`ADD CONSTRAINT … CHECK` validates every existing row, and the backfill mirrors
each parent faithfully — so a database already holding a live class in an
archived room mirrors that state into a violating row and the migration aborts.
That state is the premise of this issue; the doors it replaces were measured
letting it through.

**The remediation un-archives the room.** #272 remediated the other way — it
paused the template, on the ground that the room's archive is the teacher's
stated intent — and the mirror image here is *cancelling the class*. That is
rejected: cancelling a `Class` is terminal and irreversible, may carry
registered students, and everywhere else in the app notifies them. A migration
is not a place to do that silently.

Un-archiving is also not an invention. It is already the documented recovery
for exactly this state — `room-archive.ts:184-189` names it as what makes the
accepted race tolerable — so the migration performs the repair the code already
tells a teacher to perform. The teacher re-archives afterwards, and the
constraint then lets them do it honestly or refuses with a sentence naming what
to clear.

The un-archive cascades to `ClassTemplate.roomArchived = false` through #272's
existing foreign key. That direction can only satisfy
`ClassTemplate_live_needs_open_room` (`NOT (ruleLive AND roomArchived)`) further
and can never violate it, so the two migrations do not interact.

### 2.2 The doors keep their words

Door 1 keeps its class count as the producer of the teacher-facing sentence,
with the constraint doing the enforcement — #272's shape exactly. `POST`-ing a
refusal a teacher cannot read is not an improvement, and `describeRoomBlockers`
exists to name what must be cleared.

---

## 3. The mechanism

### 3.1 The migration

Five steps, in this order. Step 2 must precede step 3.

```sql
-- 1. Entry liveness, per row, so a foreign key can reference it.
ALTER TABLE "CalendarEntry" ADD COLUMN "live" BOOLEAN
  GENERATED ALWAYS AS ("cancelledAt" IS NULL) STORED;
-- NOT NULL is required, not tidy, for the reason ScheduleRule.live's is: a
-- generated column is nullable by default and Prisma's Boolean is required,
-- so without this the drift check in CI fails.
ALTER TABLE "CalendarEntry" ALTER COLUMN "live" SET NOT NULL;
ALTER TABLE "CalendarEntry" ADD CONSTRAINT "CalendarEntry_id_kind_live_key"
  UNIQUE ("id", "kind", "live");

-- 2. REMEDIATION, before the backfill below.
UPDATE "TeacherRoom" tr SET "isArchived" = false
 WHERE tr."isArchived"
   AND EXISTS (SELECT 1 FROM "Class" c
                 JOIN "CalendarEntry" ce ON ce."id" = c."calendarEntryId"
                WHERE c."teacherRoomId" = tr."id"
                  AND c."status" IN ('open','in_progress')
                  AND ce."cancelledAt" IS NULL);

-- 3. The mirrors, backfilled from the parents they mirror.
ALTER TABLE "Class" ADD COLUMN "entryLive"    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Class" ADD COLUMN "roomArchived" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Class" c SET "entryLive"    = ce."live"
  FROM "CalendarEntry" ce WHERE ce."id" = c."calendarEntryId";
UPDATE "Class" c SET "roomArchived" = tr."isArchived"
  FROM "TeacherRoom"  tr WHERE tr."id" = c."teacherRoomId";

-- 4. The two existing foreign keys, widened to carry the mirrored column.
--    Referential actions are preserved exactly; delete behaviour is unchanged.
ALTER TABLE "Class" DROP CONSTRAINT "Class_calendarEntryId_kind_fkey";
ALTER TABLE "Class" ADD  CONSTRAINT "Class_calendarEntryId_kind_entryLive_fkey"
  FOREIGN KEY ("calendarEntryId","kind","entryLive")
  REFERENCES "CalendarEntry"("id","kind","live")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Class" DROP CONSTRAINT "Class_teacherRoomId_fkey";
ALTER TABLE "Class" ADD  CONSTRAINT "Class_teacherRoomId_roomArchived_fkey"
  FOREIGN KEY ("teacherRoomId","roomArchived")
  REFERENCES "TeacherRoom"("id","isArchived")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. The invariant.
ALTER TABLE "Class" ADD CONSTRAINT "Class_live_needs_open_room"
  CHECK (NOT ("status" IN ('open','in_progress') AND "entryLive" AND "roomArchived"));
```

The referential actions in step 4 are copied from the definitions in force, not
from Prisma's defaults:

- `Class_teacherRoomId_fkey` — `ON DELETE RESTRICT ON UPDATE CASCADE`
  (`20260403092044_init/migration.sql:345`)
- `Class_calendarEntryId_kind_fkey` — `ON DELETE CASCADE ON UPDATE CASCADE`
  (`20260826080100_calendar_entry_rewire/migration.sql:94-96`)

`CalendarEntry_id_kind_key` (`UNIQUE (id, kind)`) already exists
(`20260826080000_calendar_entry/migration.sql:68`) and is untouched;
`CalendarEntry_id_kind_live_key` is a second key beside it, needed because a
foreign key must reference the exact column list it carries.

### 3.2 Why the CHECK names the statuses in SQL

`BLOCKING_CLASS_STATUSES` stays in `room-archive.ts` as the application's
copy, and the CHECK spells the same two literals. That is a duplication and it
is the intended one: a database constraint cannot import a TypeScript constant,
and the alternative — deriving the SQL from the constant at migration time —
would make an applied migration's meaning depend on a file that can later
change, which is precisely what an immutable migration must not do.

What keeps them from drifting is a test, not a comment: a case that asserts the
constraint refuses each member of `BLOCKING_CLASS_STATUSES` and permits every
other `ClassStatus`, iterating the enum rather than a hand-written list, so
adding a member to the enum without deciding its side fails.

### 3.3 `StudioClass` is untouched

`CalendarEntry.live` is new infrastructure on a table both families share, but
only `Class`'s foreign key widens to carry it. `StudioClass` has no room, no
`roomArchived`, and no invariant of this shape — `StudioClass_calendarEntryId_kind_fkey`
keeps referencing `CalendarEntry(id, kind)` unchanged.

---

## 4. Evidence

### 4.1 The two races this closes

**Door 2.** Publish reads `teacherRoom.isArchived` at `class-lifecycle.ts:401`,
outside the transaction. The CAS at `:529` writes `status` under
`lockClassRow`, with no predicate on the room. A room archived between the two
is invisible, and the class is published into it.

**Door 1.** `setTeacherRoomArchived` counts blocking classes at
`room-archive.ts:148-156` and writes at `:237`. A class published in another tab
between them leaves an archived room holding an `open` class. This is the
long-standing `KNOWN-OPEN` at `:178-199`.

Both become refusals: the write itself trips `Class_live_needs_open_room`,
because the mirrors put the whole predicate on the row being written.

### 4.2 The new wait edges

Two, both created by `ON UPDATE CASCADE`, and both argued here and pinned by
test in the plan.

**`CalendarEntry → Class`** — flipping `cancelledAt` changes the generated
`live`, which cascades into `Class.entryLive`, locking the class row while the
transaction holds the entry. That is the reverse of this repo's fixed order
(`Class` first, then its entry — `docs/lock-order.md`, "Ordering BETWEEN
`Class` and its `CalendarEntry` (#327)").

It is safe because every writer of `cancelledAt` on a **regular** entry already
holds the `Class` row lock first, so the cascade re-locks a row the transaction
owns and waits on nothing:

| writer | `Class` lock | entry write |
|---|---|---|
| `api/classes/[id]/cancel/route.ts` | `:61` `lockClassRow` | `:66` |
| `services/class-transitions.ts` (auto-cancel) | `:410` `lockClassRow` | `:487` |
| `services/gdpr.ts` (erasure) | `:1120` `lockClassRowsOrdered` | `:1209` |
| `services/gdpr.ts:1292` | — | `kind: 'studio'`; no `Class` child |

Re-derive the writer set with:

    grep -rn "cancelledAt: new Date()" --include="*.ts" src/ | grep -v '\.test\.'

which returns 7 lines. Three write `Registration.cancelledAt` — a different
column on a different table — at `api/registrations/[id]/route.ts:269`, `:285`
and `gdpr.ts:529`. `7 − 3 = 4`, the four rows of the table above.

The third of those is why the subtraction has to be done by reading rather than
by path: `gdpr.ts:529` writes a `Registration` while *filtering* on
`calendarEntry: { cancelledAt: null }`, so it sits in a statement that mentions
both columns.

The flip is also one-way for this family: `entry_terminal_liveness_guard`
refuses a change to `cancelledAt` on a terminal REGULAR entry, so the cascade
fires at most once per class.

**`TeacherRoom → Class`** — archiving a room rewrites `roomArchived` on every
class in it, locking those rows while the transaction holds the room. The
counterparty would be a transaction holding a `Class` row lock that then waits
on `TeacherRoom`. There is none:

- A status-only `UPDATE` on `Class` triggers no referential check at all,
  because no foreign-key column changes — so `transitionClass`, `completeClass`
  and both sweeps take no room lock despite holding `Class`.
- The only statement taking `KEY SHARE` on a room is a `Class` **INSERT**
  (`api/classes/route.ts:127`, `class-generator.ts:49`), and an insert holds no
  prior lock on the row it is creating.
- `gdpr.ts` never writes `TeacherRoom` — `grep -n "teacherRoom\.\|teacherRoom:" src/services/gdpr.ts`
  returns nothing.

The generator's insert does take `KEY SHARE` on the room while the archive
wants an exclusive lock on it, but the two serialise earlier: both take the
room's `ClassTemplate` rows `FOR UPDATE` first (§1.4).

### 4.3 The defect this change would introduce if missed

`ROOM_DELETE_RESTRICT_FKS` (`room-deletion.ts:43-46`) matches foreign keys **by
literal name**, and one entry is `'Class_teacherRoomId_fkey'`. Step 4 renames
it. Left unedited, `isRoomDeleteBlocked` stops recognising a class blocker and
`DELETE /api/rooms/[id]` returns a 500 where it returned a clean 409 naming the
remedy.

Nothing currently pins that wiring, and this is measured rather than assumed —
the function's own docblock records it: replacing the list with `[]` at both
call sites left every case in both integration suites green, because both
routes are stopped by their pre-check and never reach the catch.

So the fix is two parts: the new name in the list, and a test that reaches the
catch — a delete refused by the database rather than by the pre-check. Folded
into this issue rather than filed, because this change is what makes the stale
name wrong.

---

## 5. The docblock, written now

On `Class`, above the two mirror columns. It states what is true, carries no
count and no history, and tethers nothing it cannot tether:

> MIRRORS. Neither column is state this row owns, and neither may disagree with
> the parent it mirrors. `entryLive` mirrors `CalendarEntry.live`
> (`cancelledAt IS NULL`, generated); `roomArchived` mirrors
> `TeacherRoom.isArchived`.
>
> Neither can drift, and that is enforced rather than intended: each is one
> column of a composite foreign key whose remaining columns are the parent's
> key, so a row claiming a value its parent does not hold is refused with
> `23503` instead of stored, and `ON UPDATE CASCADE` rewrites every mirroring
> child in the same statement that changes the parent.
>
> They are not written the same way. `entryLive` is maintained by Postgres
> alone: a class is created with a fresh, uncancelled entry, so the column's
> default is the only value it can start with, and nothing in `src/` writes it
> afterwards. `roomArchived` is written by the two create paths, which COPY the
> room's value — and copy rather than assert, unlike
> `ClassTemplate.roomArchived`, because a `draft` may legally sit in an
> archived room. Neither is written by an update: no path moves a class between
> rooms (`updateClassSchema` carries no `teacherRoomId`), and cancellation
> writes the entry.
>
> They exist so a predicate spanning three tables can be checked against one
> row. That check is `Class_live_needs_open_room`, hand-authored in the
> migration because Prisma cannot express it — the constraint that makes "a
> live class may not sit in an archived room" unrepresentable rather than
> merely guarded (issue 339).

A second, shorter one on `CalendarEntry.live` recording that it is generated,
that `Class` references it, and that `StudioClass` does not.

---

## 6. What happens to the application doors

### 6.1 Door 2 — `transitionClass`

The pre-check at `class-lifecycle.ts:428-445` stays as-is: it produces the
sentence, and it runs before the past-start check for the reason its comment
gives. What is added is a `catch` around the CAS transaction on
`isCheckViolationOn(e, 'Class_live_needs_open_room')`, returning the same
`ROOM_ARCHIVED` refusal with the same message. The race is then closed by the
constraint, and the pre-check is a probe in front of it.

### 6.2 Door 1 — `setTeacherRoomArchived`

The class count moves into a closure beside `countLiveTemplates`, under that
function's existing "ONE EXPRESSION, TWO READERS" discipline, so the pre-write
count and the post-rollback re-count cannot ask different questions. The
`catch` widens to either constraint and re-counts **both**.

That incidentally corrects an understatement: today's catch returns
`{ classes: 0, templates }` unconditionally, so a teacher who raced a template
*and* published a class reads a sentence naming only the template.

The `KNOWN-OPEN` block at `:178-199` is **deleted**, not narrowed — the state it
describes stops being reachable. What it used to say goes in the PR body.

### 6.3 Room deletion

`ROOM_DELETE_RESTRICT_FKS` gains the new name (§4.3) and a test that reaches
the catch.

### 6.4 The two create paths — copy, do not assert

This is the one place where copying #272 produces a bug, so it is stated
positively rather than left to the pattern.

`Class.roomArchived` arrives with `DEFAULT false`, and the foreign key refuses
any row whose value disagrees with the room's. A class created in an **archived**
room therefore needs `roomArchived: true` written explicitly — and such a class
is legal, because it is a `draft` (§1.3). #272's create path
(`api/class-templates/route.ts:94-116`) instead **asserts** `roomArchived: false`
and maps the resulting `23503` to a 409, which is right for a template (a live
template in an archived room is illegal) and wrong for a class (a draft in one
is not).

Both class create paths must copy:

- **`class-generator.ts:49`** copies `template.roomArchived`, the mirror
  `ClassTemplate` already carries. Accurate by the lock that already protects
  this path: archiving the room cascades into that template row, which the
  generator holds `FOR UPDATE` across `createChildren` (§1.4), so the archive
  cannot commit between the read and the insert.
- **`api/classes/route.ts:127`** copies the `teacherRoom.isArchived` it already
  reads at `:79` for the ownership check. This one has a real window between
  that read and the insert; §7.4 is the choice of how to close it.

Both are covered by a test that creates a draft in an archived room and expects
success — the case that fails loudly if either path reverts to asserting.

---

## 7. Open sub-choices for the plan

1. **The index on `Class(teacherRoomId, roomArchived)`.** #272 added the
   equivalent for `ClassTemplate` only after measuring (its §7.3, results in
   `docs/lock-order.md`). `Class` has no index on `teacherRoomId` today. **Two**
   paths read the referencing side here, not the three #272 had: the archive's
   `ON UPDATE CASCADE` and the room-delete `ON DELETE RESTRICT` check. #272's
   third was the archive's explicit pre-lock on `ClassTemplate`, and this door
   has no counterpart — it takes no `Class` lock, which is the very thing
   `room-archive.ts:186-189` declines to add. Measure at 10k and 100k rows and
   decide; a separate migration if it lands, as #272's was.
2. **Whether door 1's re-count discriminates by constraint.** Re-counting both
   on either violation is simpler and always correct; counting only the one
   that fired is one branch cheaper and can understate. Recommend both.
3. **Where the enum-exhaustiveness test for §3.2 lives** — beside the
   constraint tests, or in `room-archive`'s suite.
4. **How `POST /api/classes` closes its read-to-insert window** (§6.4). Three
   candidates, and the plan should settle it with a measurement rather than by
   argument:
   - **`FOR SHARE` on the room row inside the create transaction** (recommended).
     It conflicts with the archive's row lock, so the copied value cannot be
     stale. Note that archiving now takes `FOR UPDATE` rather than
     `FOR NO KEY UPDATE`, because `isArchived` became part of an FK-referenced
     unique key in #272 — which is also why the insert's own `KEY SHARE`
     already conflicts, leaving only the read-to-insert gap to close. Adds a
     `TeacherRoom` lock node whose order (`TeacherRoom → Class`) matches the
     archive's own, so it introduces no cycle.
   - **Catch the `23503` and retry once.** No new lock node; costs a retry path
     and a second failure mode to define.
   - **Accept it and map `23503` to a transient 503.** Cheapest, and the only
     one that fails a legal operation — a draft create refused because the
     teacher archived the room in another tab.

   Whichever lands, the acceptance test is the same: creating a draft in a room
   that archives mid-request must not 500.

---

## 8. Scope

**In:** the migration, the two mirrors, the CHECK, `CalendarEntry.live`, the
two door changes, the mirror-copy in both create paths (§6.4), the
`ROOM_DELETE_RESTRICT_FKS` rename and its missing test, the
`docs/lock-order.md` section, the schema docblocks.

**Out, deliberately:**

- **Changing which statuses block.** `BLOCKING_CLASS_STATUSES` stays
  `['open','in_progress']`; `draft`'s exclusion is deliberate and documented.
- **The `StudioClass` family.** It has no room.
- **Any change to #272's template constraint.** Issue 272 is unaffected.
- **The "archive anyway, and pause what blocks it" affordance**, still filed
  from #272 §8 and still not built.

---

## 9. Acceptance

1. The migration applies to a database built from the real history, and to a
   copy carrying a deliberately-planted violating row, which it remediates by
   un-archiving that row's room.
2. `npx prisma migrate diff … --exit-code` exits `0`, demonstrated alongside a
   deliberately-broken variant that exits `2`.
3. Door 2 and door 1's class half are each refused by the constraint in tests
   that drive the database rather than the service, and a `draft` on an
   archived room still succeeds.
4. Both create paths write an accurate `roomArchived`: creating a draft in an
   archived room succeeds through `POST /api/classes`, and does not 500 when
   the room archives mid-request (§7.4). The generator's copy is covered by a
   case that would fail if it asserted `false` instead.
5. The concurrent interleaving for each door lands as a passing test with a
   negative control proving it reproduces the bug when the constraint is
   dropped.
6. Every guard is mutation-tested: dropping the CHECK reddens the door tests;
   dropping `SET NOT NULL` reddens the drift check; narrowing either widened
   foreign key to its old column list reddens the tamper test; reverting the
   `ROOM_DELETE_RESTRICT_FKS` entry reddens the new delete test. Each
   mutation's exact error text is recorded, and each is restored and
   re-verified.
7. The enum-exhaustiveness test of §3.2 fails when a `ClassStatus` member is
   added without deciding its side.
8. The `KNOWN-OPEN` note at `room-archive.ts:178-199` is removed.
9. `docs/lock-order.md` gains the two edges of §4.2, with the writer table and
   its re-derivation command.
10. `npm run verify` is green for the tiers a worktree can run (typecheck, lint,
   unit, components); the integration and e2e tiers are cited from CI.

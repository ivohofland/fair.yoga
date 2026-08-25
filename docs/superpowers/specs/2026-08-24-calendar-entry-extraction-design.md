# Calendar entry extraction — design (#298, #297)

**Status:** decision recorded; implementation filed separately and not started.

#298 and #297 are `question` issues whose acceptance is a recorded decision, not
a diff. Both already carry substantial conclusions in their comments. This
document is that decision in final form, with two differences from the comments
it supersedes: every number is re-derived against `prisma/schema.prisma` and the
running database rather than inherited, and the two acceptance bullets #297 still
had open are answered.

The branch that carries this document changes no application code.

---

## 1. The decision

**#298 — option C and option D, together, both as extraction.**

Two tables are extracted. Four are kept as economic specialisations.

- **`CalendarEntry`** takes the instance-level calendar identity. `Class` and
  `StudioClass` remain, holding their economics.
- **`ScheduleRule`** takes the rule-level calendar identity plus the shared
  lifecycle flags. `ClassTemplate` and `StudioClassTemplate` remain, holding
  theirs.

**Option B — one table with a `type` discriminator — is rejected at both
layers**, and recorded so it is not re-proposed. Option A (keep the two families
separate and patch each cross-family invariant as it appears) is superseded, not
refuted: it is what the codebase does today, #296 is its most recent instalment,
and it stays correct until this lands.

**#297 — absolute non-intersection, half-open intervals.**

A teacher's live entries may not overlap. `[start, start + duration)`, so a class
ending 20:00 and one starting 20:00 are legal and an ordinary back-to-back
teaching day is not banned. The *buffer* option is rejected: it needs a buffer
value and arguably a per-location one, which is a larger design than the problem
justifies. *Warn-only* is rejected: once `durationMinutes` sits on the entry the
database can express the rule exactly, and a warning is strictly weaker than a
constraint that is already free.

**Both layers take that mechanism, not just the entry layer.** `ScheduleRule`
gets a range exclusion as well — correcting a recorded conclusion that would
have kept exact-start matching there on reasoning that does not hold in this
system (§2.2f, §4.4).

**The two decisions are one mechanism.** #297 is not a follow-up to #298 — it is
what `durationMinutes` moving onto the entry *means*. Deciding them apart is what
made them two issues; implementing them apart is not possible.

---

## 2. What was re-derived, and where the recorded conclusions were wrong

### 2.1 The census holds exactly

Re-derived by extracting declared fields (including relations, excluding
attribute lines and comments) from `prisma/schema.prisma`:

```
for m in Class StudioClass ClassTemplate StudioClassTemplate; do
  awk -v M="$m" '$1=="model" && $2==M {f=1;next} f&&/^}/{exit} f' prisma/schema.prisma \
    | grep -vE '^\s*(//|$|@@)' | awk '{print $1}'
done
```

| Pair | A | B | shared | union | overlap |
|---|---|---|---|---|---|
| `Class` / `StudioClass` | 31 | 15 | 11 | `31 + 15 − 11 = 35` | `11 / 35 = 31%` |
| `ClassTemplate` / `StudioClassTemplate` | 24 | 16 | 13 | `24 + 16 − 13 = 27` | `13 / 27 = 48%` |

Every figure in #298's body reproduces. `Class`-only 20, `StudioClass`-only 4
(`location`, `studentCount`, `hourlyRate`, `cancelledAt`); `ClassTemplate`-only
11, `StudioClassTemplate`-only 3 (`location`, `hourlyRate`, `studioClasses`).

The reading of that census also holds, once its partition is made to close.
Of the 11 instance-level shared fields, three are bookkeeping (`id`,
`createdAt`, `updatedAt`) and two are parallel rather than common (`template` /
`templateId` point at two *different* tables). The remaining **six** fields
carry **five concepts**, because `teacher` and `teacherId` are one — a relation
and its scalar. `3 + 2 + 6 = 11`. Four of the five concepts are the calendar
slot:

```
teacherId   date   startTime   durationMinutes        classType
└──────────────── the slot ─────────────────┘        └── kind of thing ──┘
```

### 2.2 Six recorded claims that do not survive re-derivation

Five of the six leave the decision intact; the sixth changes the shape of one
constraint. All are stated because an artifact that carries a wrong number
teaches the wrong method (`.claude/skills/solve-issue` §2), and four of them are
load-bearing for the implementation.

**(a) `durationMinutes` is validated today.** Both #297's body and #298's
decision comment say it "participates in no key, no constraint, and no
validation anywhere". The first two clauses hold — it appears in
`prisma/migrations/` only as four column declarations, in no index and no
`CHECK`. The third is false: `src/lib/schemas.ts` bounds it
`z.number().int().positive()` at **8** sites, and `class/new/page.tsx:248`
adds a client-side check.

```
grep -rn "durationMinutes" src/lib/schemas.ts | wc -l    # 8
```

**And the narrower claim that replaced it was also wrong** — a correction of a
correction, which is the shape CLAUDE.md warns about. An earlier draft of this
section said "nothing in this system computes when a class ends". It does, twice:

```
grep -rn "durationMinutes \* 60 \* 1000" src --include='*.ts' | grep -v '\.test\.'
src/services/class-transitions.ts:532
src/services/class-lifecycle.ts:550
```

Both compute `classStartInstant(date, startTime, teacher.defaultTimezone) +
durationMinutes`, and both are live. `class-lifecycle.ts:550` is
`completeClass`'s authoritative `requireEndedBy` gate — the check that a class
cannot be completed before it has ended — evaluated **under the row lock**.
`class-transitions.ts:532` is `autoCompleteClasses`'s pre-filter, which its own
comment marks as an optimisation whose staleness can only delay a completion.

So what is true is narrower again, and this time scoped: **the `Class` family
computes an end instant in two places; the `StudioClass` family computes none,
and `durationMinutes` enters no key, constraint or index in either.** The last
clause is what the exclusion constraint is new relative to; the first is a
consequence for the implementation, recorded in §11.

The wrong-producing method is worth naming, because it is subtle: the
`durationMinutes` reference list was read by eye and paths shaped like
`settings/…` and `…/page.tsx` were classified as display — which skips
`src/services/` entirely, the one directory where the claim could fail.

The rest of (a) holds: the two money sites are
`settings/reporting/page.tsx:53` and `studio-class/[id]/page.tsx:83`, and
`durationMinutes` appears in `prisma/migrations/` only as four `INTEGER NOT
NULL` column declarations.

**(b) The `'cancelled'` audit arithmetic is wrong; its headline is right.**
The decision comment states: *"14 grep hits in `prisma/migrations/` = 2 comments
+ 2 `ClassStatus` declarations + 2 unrelated enums + 8 predicates."*

Measured:

```
grep -rn "'cancelled'" prisma/migrations --include="*.sql" | wc -l    # 11
```

`11 = 2 ClassStatus declarations + 1 RegistrationStatus declaration + 8 predicates.`

Three of the four terms are wrong. There are no comment hits — prose about
cancellation writes the bare word, which the quoted-literal grep cannot match.
There is one unrelated enum, not two: `RegistrationStatus` carries `'cancelled'`,
but `NotificationType`'s member is `'class_cancelled'`, which a search for
`'cancelled'` does not match either.

**The headline survives intact: 8 live SQL predicates across 4 migrations**, and
they are the sites the comment names — `class_terminal_status_trigger:18`,
`teacher_slot_unique_indexes:12`, `class_terminal_date_trigger:39`, and five in
`cross_family_slot_guard` (41, 95, 107, 109, 129). A correct answer reached by a
method that could not have produced it is still worth correcting, because the
method is what the next audit inherits.

**(c) That audit is one half of the liveness audit, not the whole of it.**
`'cancelled'` is how the `Class` family spells liveness. The `StudioClass` family
spells it `cancelledAt IS NULL`, and those predicates are invisible to the grep
above:

```
grep -rn '"cancelledAt" IS \(NOT \)\?NULL' prisma/migrations --include="*.sql" | wc -l   # 6
```

`teacher_slot_unique_indexes:16` and five in `cross_family_slot_guard`
(42, 78, 146, 153, 155). **The extraction collapses both halves into one column,
so the audit is `8 + 6 = 14` live SQL predicates, not 8.** Ten of the fourteen
are inside `cross_family_slot_guard`, which this work deletes outright.

**(d) The compiler half is real but does not work the way it is described.**
The comment says deleting the enum member "makes every affected TypeScript
`switch` a compile error". Measured:

```
grep -rn "'cancelled'" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | wc -l        # 48
grep -rn "case 'cancelled'" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | wc -l   # 1
```

There is **one** switch arm. The protection is real but comes from a different
mechanism: Prisma generates `ClassStatus` as a string-literal union, so all 48
sites — `status === 'cancelled'`, `status: { not: 'cancelled' }`, `where`
inputs — fail assignability when the member leaves. That is a stronger guarantee
than switch exhaustiveness, and stating it correctly matters because the
implementer will be looking for switches and finding one.

**(e) The generator line counts have drifted.** #298 cites 645 and 309 lines;
they are now **736** (`class-generator.ts`) and **402**
(`studio-class-generator.ts`), from #276 and #282 landing since. The structural
claim the numbers were supporting is unaffected — see §2.3.

**(f) The rule layer's exact-start justification describes a system this is
not — and this one does change the design.** #298's decision comment keeps
exact-start matching on the rule layer, reasoning that an overlapping rule pair
is "not themselves a contradiction" because "rule conflict is derived from
activity and date range, not from the columns".

Measured: **no rule has a date range.** A template runs indefinitely (CLAUDE.md,
*Class Lifecycle*), and the slot predicate is partial on `isArchived` alone — a
paused rule still holds its slot. Every live rule therefore reaches every week,
so an overlapping rule pair collides every week, exactly as certainly as an
identical-start pair does. There is nothing to derive.

Left standing, that claim would have produced a design that refuses one certain
conflict at edit time and admits an equally certain one. **§4.4 corrects it: the
rule layer takes the same range exclusion as the entry layer.** This is the one
correction in this section that reaches past its own numbers into the schema,
and it was found at the spec gate rather than by re-derivation — the credit
belongs to the review, not to the sweep.

### 2.3 The deferred generator read, which was the one thing that could have reopened the sequencing

#298's sequencing comment made a commitment it did not discharge:

> The claim should be validated by **reading** the two generators […] during
> this issue's design, not by shipping the studio half to find out. If that read
> shows the two generators differ essentially rather than accidentally, that is
> the finding that reopens this sequencing.

**The read was done. It confirms.** `generateStudioInstancesForTemplate`
(`studio-class-generator.ts:128`) is `generateInstancesForTemplate`
(`class-generator.ts:204`) minus exactly two things:

1. **Week-keyed occupancy** — the second `templateId`-scoped read plus
   `isWeekHeld` / `firstFreeWeek` (`class-generator.ts:107`, `:134`), the #194
   rule. This is #284's entire content.
2. **The empty-window warn guard** (`class-generator.ts:263`–`:275`), which
   reports a window emptied by an unreadable start instant.

Everything else is line-for-line parallel: the same `getNextOccurrences` +
`DEFAULT_WEEKS` window, the same `classStartInstant(...) > startDate` filter,
the same single occupancy query, the same cross-family `foreign` read, the same
skip ordering (`already_generated` / `blocked_by_cancelled` → `slot_taken` →
`blocked_by_other_family`), the same `createManyAndReturn` with `skipDuplicates`,
the same `raced` reconciliation against the returned rows, the same sort, the
same `logSkipped*`.

Both absences are **accidental** — studio has simply never had #194 applied to
it — not essential. The sequencing stands: **#284 is not a gate**, and shipping
week-keying on `studio-class-generator.ts` first would mean writing it twice.

---

## 3. Target schema

### `CalendarEntry`

```
id                text     PK
teacherId         text     FK → Teacher
kind              enum     regular | studio
date              date
startTime         time                          -- was String "HH:MM"; see §6
durationMinutes   int      CHECK > 0
cancelledAt       timestamptz?                  -- the single spelling of liveness
scheduleRuleId    text?    FK → ScheduleRule
span              tsrange  GENERATED ALWAYS AS (…) STORED   -- see §4

UNIQUE (id, kind)                               -- the composite-FK parent key
UNIQUE (scheduleRuleId, date)                   -- total, NOT partial; see §5.2
EXCLUDE USING gist (teacherId WITH =, span WITH &&) WHERE (cancelledAt IS NULL)
```

### `ScheduleRule`

```
id                text     PK
teacherId         text     FK → Teacher
kind              enum     regular | studio
classType         text
dayOfWeek         int
startTime         time
durationMinutes   int
isActive          bool
isArchived        bool
archivedAt        timestamptz?
withdrawnCount    int
slot              int4range  GENERATED ALWAYS AS (…) STORED   -- minutes since midnight

UNIQUE (id, kind)
EXCLUDE USING gist (teacherId WITH =, dayOfWeek WITH =, slot WITH &&)
  WHERE (isArchived = false)                                  -- see §4.4
```

`slot` is minutes since midnight rather than a time range, because PostgreSQL has
no built-in range type over `time`:

```sql
slot int4range GENERATED ALWAYS AS (
  int4range( (EXTRACT(HOUR FROM "startTime")*60 + EXTRACT(MINUTE FROM "startTime"))::int,
             (EXTRACT(HOUR FROM "startTime")*60 + EXTRACT(MINUTE FROM "startTime"))::int
               + "durationMinutes",
             '[)' )
) STORED
```

### What the four surviving tables keep

`Class` sheds `date`, `startTime`, `durationMinutes`, `classType`, `templateId`
and the `cancelled` member of `status`; it gains `(entryId, kind)`. It keeps its
entire economic and lifecycle model — `teacherRoomId`, `roomCost`, `minRate`,
`targetRate`, `minStudents`, `maxStudents`, `settingsLocked`, `status`,
`effectiveTeacherRate`, `totalStudents`, `totalRevenue`, `autoCancelCheck`,
`cancelDeadline`, `spotBroadcastAt` — and all four relations
(`registrations`, `waitlistEntries`, `notifications`, `announcements`), which
continue to point at `Class` and are therefore *unaffected* by the extraction.
That last point is what option B could not offer: under a discriminator merge
nothing would stop a `Registration` pointing at a studio-type row.

`StudioClass` keeps `location`, `studentCount`, `hourlyRate`. The two template
tables keep their economics identically.

### Disjoint occupancy is a composite foreign key

`UNIQUE (id, kind)` on the parent; each child carries `(entryId, kind)` with a
`CHECK` pinning its own literal and a composite FK to `(id, kind)`.

Without this the extraction does not close the cross-family hole — one entry
could otherwise carry a child of each family, which is the exact defect #296
exists to prevent. Totality is not constrained (an entry with no child is
permitted by the schema); parent and child are created in one transaction.

**Measured, both directions** (§4 probe): a `studio` child on a `regular` entry
is refused `23503`, and flipping a parent's `kind` while a child is attached is
also refused `23503`.

---

## 4. Occupancy: the exclusion constraint, measured rather than asserted

Prisma cannot express exclusion constraints, so this joins the existing family of
hand-authored, comment-documented invisible constraints. Net the family shrinks:
four partial unique indexes and eight triggers become two exclusion constraints
(§7.1).

### 4.1 Three prerequisites, all confirmed against `fairyoga-db-1`

**`btree_gist` is available and trusted**, so a non-superuser table owner can
install it — no superuser is needed on the VPS.

```
SELECT name, version, trusted FROM pg_available_extension_versions WHERE name='btree_gist';
--  btree_gist | 1.7 | t
```

**A text start time blocks the constraint outright.** An exclusion constraint
needs an `IMMUTABLE` index expression and the text-to-time cast is not one:

```
CREATE INDEX imm_probe_idx ON imm_probe ((s::time));
ERROR:  functions in index expression must be marked IMMUTABLE
```

This is why `startTime` must become `@db.Time` (§6). It is a prerequisite, not a
preference.

**With a real `time` column the generated span builds.** `date + time` and
`+ interval` are immutable, so the range can be a stored generated column rather
than an expression index:

```sql
span tsrange GENERATED ALWAYS AS (
  tsrange(date + "startTime",
          date + "startTime" + ("durationMinutes" * interval '1 minute'),
          '[)')
) STORED
```

### 4.2 The constraint bites — eleven mutations, each with a verdict

Run against a scratch schema carrying the §3 shape. Baseline: teacher `T1`,
2026-09-01, 19:00, 90 minutes (19:00–20:30).

| Mutation | Expected | Measured |
|---|---|---|
| `T1` 19:30 +60 — overlaps the tail | refused | **REFUSED** `23P01` |
| `T1` 20:30 +60 — starts exactly at the end | accepted | **ACCEPTED** |
| `T1` 19:00 +60 — same instant, shorter | refused | **REFUSED** `23P01` |
| `T2` 19:30 +60 — different teacher | accepted | **ACCEPTED** |
| `T1` 19:30 +60 on 2026-09-02 — next day | accepted | **ACCEPTED** |
| `T1` 19:30 +60 **cancelled** — overlapping but dead | accepted | **ACCEPTED** |
| un-cancel that row back into the live overlap | refused | **REFUSED** `23P01` |
| `T1` 23:30 +60 on 09-03 — spills past midnight | accepted | **ACCEPTED** |
| `T1` 00:15 +30 on 09-04 — collides with that spill | refused | **REFUSED** `23P01` |
| `T1` `note` edited on a conforming row | accepted | **ACCEPTED** |
| `T1` duration 90 → 150, newly overlapping a later row | refused | **REFUSED** `23P01` |

The half-open choice is the second row and it is the whole reason for it: under
`'[]'` an ordinary back-to-back teaching day would be banned.

The sixth and seventh rows are the partial predicate working: a cancelled entry
releases its slot, and re-entering an occupied one is refused. **That is not new
behaviour** — `slot-constraints.test.ts:290` and `:439` already pin
"un-cancelling into an occupied slot is rejected" under #296's triggers. What
changes is the *width* of the refusal, from exact start to range overlap. The
un-cancel write is at `api/studio-classes/[id]/route.ts:143`, whose comment
already flags the re-entry hazard; that comment's scope widens with the
constraint and must be revised, not left standing.

### 4.3 A capability no per-date key could have had

The eighth and ninth rows are worth stating separately, because they are not a
generalisation of the current rule — they are outside its reach entirely.

Both of today's **entry-level** slot indexes key on `(teacherId, date,
startTime)` — the two rule-level ones key on `dayOfWeek` instead (§7.1). A class
at 23:30 running 60 minutes ends at 00:30 **the next day**, on a different
`date` value. No per-date key can see that collision, and no widening of one
ever could. The range constraint catches it as an ordinary consequence of its
shape.

This is a small, real correctness gain that neither issue anticipated. It also
means the constraint's semantics are "one teacher's local timeline", not "one
teacher's day".

### 4.4 The rule layer takes the same range exclusion — which corrects a recorded claim

#298's decision comment specifies exact-start matching at the rule layer and
justifies it this way: two rules on Tuesday 19:00/90min and Tuesday 19:30 "are
not themselves a contradiction […] rule conflict is derived from activity and
date range, not from the columns."

**That justification describes a system this one is not.** No rule has a date
range — a template "runs indefinitely" (CLAUDE.md, *Class Lifecycle*) — and
`isActive = false` does not release a slot, only `isArchived` does. So every
live rule reaches every week, and a Tuesday 19:00/90 rule and a Tuesday 19:30/60
rule collide **every week**, exactly as certainly as two identical-start rules
do. Carrying the claim forward would have left the design refusing one certain
conflict at edit time — via the exact-start unique index this section replaces —
while waving an equally certain one through to a generation skip.

So the rule layer takes the same mechanism as the entry layer: **range overlap,
partial on not-archived, cross-family by construction.**

Measured against `fairyoga-db-1` on the §3 shape. Baseline: `T1`, Monday 19:00,
90 minutes, `kind = regular`.

| Mutation | Expected | Measured |
|---|---|---|
| Mon 19:30 +60 **studio** — overlaps, other family | refused | **REFUSED** `23P01` |
| Mon 19:00 +60 **studio** — same start, other family | refused | **REFUSED** `23P01` |
| Mon 20:30 +60 studio — starts exactly at the end | accepted | **ACCEPTED** |
| Tue 19:30 +60 — different weekday | accepted | **ACCEPTED** |
| Mon 19:30 +60 — **archived** | accepted | **ACCEPTED** |
| Mon 19:30 +60 — different teacher | accepted | **ACCEPTED** |

The fifth row is the existing behaviour preserved: the
`20260811202634` migration's own comment says *"Archived templates are excluded
so archiving frees the slot"*, and that stays true. Note the asymmetry it
implies, because it is easy to misread — **archiving frees a slot, pausing does
not.** `isActive` is absent from the predicate today and stays absent.

`EXTRACT(HOUR FROM …)` on a `time` value is immutable, so the generated
`int4range` column builds — the same prerequisite question §4.1 had to settle
for the entry layer, asked and answered independently here.

**What this does not reach.** A `(dayOfWeek, slot)` key cannot see a rule that
spills past midnight: Monday 23:30 +60 and Tuesday 00:15 +30 are two different
`dayOfWeek` values and the constraint accepts both. That is the same blind spot
§4.3 describes for per-date keys, and it is acceptable for the same reason in
reverse — the **entry** constraint catches the collision when the two rules
actually generate, because entries carry real dates.

**Generation can therefore still be blocked, and the `SkipReason` consequence
survives.** Two independent paths remain: the midnight spill just described, and
a manually created class or studio class, which is an entry with no rule behind
it and which no rule-level constraint can ever anticipate. So a skip reason is
still needed — and it is a **rename rather than an addition**. #296 shipped
`blocked_by_other_family`; under the extraction there is no other family, and
the condition becomes "an existing entry overlaps this candidate". Whoever does
#288 / #291 is renaming a member, not introducing a seventh.

### 4.5 Timezone is not a problem here

The span is a naive `tsrange` with no zone, and that is correct *because* the
constraint is scoped `teacherId WITH =`. Two entries are only ever compared
inside one teacher's own calendar, where a naive `date + time` is exactly the
right representation. `Teacher.defaultTimezone` stays what it is today — a
presentation and generation concern, used by `classStartInstant` to decide
whether a candidate date has already started — and does not enter the
constraint.

### 4.6 One constraint cannot say which family holds the slot — so a probe does

*Added 2026-08-25, during the rule-layer build. This section records a decision
the design did not make, found by measuring what §4.4 costs the API surface.*

§4.4 replaces two enforcement mechanisms with one. The two it replaces are
**distinguishable by construction** and the one that replaces them is not:

| Refusal | Raised by | Survives §4.4? |
|---|---|---|
| this teacher's *own* family already holds the slot | `ClassTemplate_teacher_slot_unique` / its studio twin → `P2002` | **no** — index dropped |
| the *other* family holds it | the four #296 template triggers → `YG001` | **no** — triggers dropped |
| either of the above | `ScheduleRule_teacher_slot_excl` → `23P01` | replaces both |

A `23P01` reports the conflicting key values in `DETAIL`. It does not report the
conflicting row's `kind`, and no formulation of the constraint could make it —
the constraint is one index over one table, and "which family" is a column on
the row it collided with, not part of the key.

**Measured cost if nothing is done: four distinct 409s become one 500.**
`isUniqueConflictOn(err, ['teacherId','dayOfWeek','startTime'])` and
`isCrossFamilySlotConflict(err)` both keep compiling and both start always
returning `false`, so every template slot conflict falls through to
`withErrorHandler`. 31 occurrences of the two `reason` strings across four
non-test files, none of which `tsc --noEmit` can see.

**Decision: one reason, and a probe supplies the discriminator.** The services
return `{ ok: false, reason: 'slot_conflict', heldBy }` where `heldBy` is
`'regular' | 'studio' | 'unknown'`, read by querying `ScheduleRule`'s generated
`slot` column after the write has already been refused. The four existing error
codes and both existing sentences survive with their meanings intact.

Three things make this the right shape rather than a workaround:

- **The sentence was never a function of the writer.** Measured across the four
  template routes, `DUPLICATE_TEMPLATE_SLOT` and `CROSS_FAMILY_CLASS_TEMPLATE_SLOT`
  carry the *same* sentence, and so do `CROSS_FAMILY_STUDIO_TEMPLATE_SLOT` and
  `DUPLICATE_STUDIO_TEMPLATE_SLOT`. Copy depends only on which kind of rule
  holds the slot. The old two-reason split encoded that fact indirectly, through
  which database object happened to raise; `heldBy` encodes it directly.
- **The schema merging the families does not merge the product.** Recurring
  classes and studio classes remain separate surfaces in Settings, so "go look
  at your studio classes" stays the actionable half of the refusal even though
  one table now holds both. This is the one place where §4.4's "under the
  extraction there is no other family" does *not* carry up — it is true of the
  schema and false of the UI.
- **`'unknown'` is a real state, not a defensive default.** The refusing rule can
  be archived between the failed write and the probe. Naming the wrong half of a
  teacher's schedule is worse than naming neither, so that case gets its own
  sentence rather than defaulting into one of the two.

**What this deliberately does not do.** It adds no pre-check. There is none at
the template layer today — both services detect purely by catching the database's
refusal, verified 2026-08-25 (neither service reads the other family's template
table at all) — and adding one would introduce a check-then-write race the
current design avoids by construction. The probe runs only after a refusal, on
the failure path, and its answer is advisory: the refusal itself is already
final.

**Where the probe may run.** A statement that fails inside a PostgreSQL
transaction aborts it, so a probe issued on `tx` would return `25P02` rather than
an answer. All six catch blocks that need it sit *outside* their own
`$transaction` call, so Prisma has already rolled back and the base client is
clean. That is a property of the current code, not a guarantee — a refactor that
moves a catch inside a transaction breaks the probe, loudly.

**The entry layer inherits this question, not this answer.** `CalendarEntry`'s
exclusion constraint will be equally silent about what it collided with, and the
two surviving instance-level codes (`CROSS_FAMILY_STUDIO_SLOT`,
`CROSS_FAMILY_CLASS_SLOT`) are still trigger-backed today. Stage B decides
whether the same probe shape serves there or whether an entry collision wants to
name the class rather than the family.

---

## 5. Liveness moves to the entry

### 5.1 One column, one spelling

`CalendarEntry.cancelledAt` becomes the single spelling of liveness for both
families. `ClassStatus` drops to four members: `draft | open | in_progress |
completed`.

This is coherent rather than merely convenient: *cancelled* is the one status the
two families genuinely share. `draft`, `open`, `in_progress` and `completed` are
regular-class lifecycle and have no studio meaning. `Class.status` keeps exactly
its own lifecycle and loses the member that was never only its own.

### 5.2 The two-rule split is promoted, not invented

`StudioClass` already implements the rule this generalises, and its docblock
already states it: **the slot constraint is partial on liveness; the
rule/date unique is not.** A cancelled entry releases its slot to a
replacement while still holding its date against the hourly sweep, so the sweep
does not recreate what a teacher cancelled.

Under the extraction that becomes one pair of constraints on `CalendarEntry`
(§3), which is why the two families stop needing to agree by hand.

### 5.3 The audit has two halves and a third thing that is not an audit

- **TypeScript — 48 sites, automatic.** Removing the enum member breaks
  assignability at every one (§2.2d). Cheap and total.
- **SQL — 14 live predicates, manual (§2.2b, §2.2c).** Invisible to the
  compiler. Ten are inside `cross_family_slot_guard` and are deleted with it.
  The dangerous survivors are the two `IN ('completed', 'cancelled')` sites —
  `class_terminal_status_trigger:18` and `class_terminal_date_trigger:39` —
  because they do not error when the member disappears, they quietly change
  meaning. **Every one of the 14 gets a written verdict in the plan**, not a
  sweep with a summary.
- **Not an audit: the migrations themselves are immutable.** These predicates
  live in applied migration files that must not be edited — a comment-only edit
  changes the checksum and nothing catches it until the next `prisma migrate
  dev` demands a reset (CLAUDE.md, *Comment Discipline*). The two surviving
  triggers are **replaced by new migrations**, not amended in place.

---

## 6. `startTime` becomes `@db.Time`, and that is the widest ripple in this work

Forced by §4.1: an exclusion constraint cannot be built over a text column.

Measured surface:

```
grep -rl "startTime" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | wc -l   # 53 files
grep -rn "startTime" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | wc -l   # 247 refs
grep -rl "startTime" src tests --include='*.ts' --include='*.tsx' | grep '\.test\.' | wc -l # 60 test files
grep -rn "timeHHmm" src --include='*.ts' | grep -v '\.test\.' | wc -l                      # 11 validator sites
```

Almost all 247 references treat the value as the string `"19:00"` — rendering it
directly, comparing it for equality, or validating it with `timeHHmm`. The
type change is mechanical but it is not small, and it is the part of this work
most likely to be under-estimated.

**The boundary decision belongs in the plan, and the recommendation is: the wire
format stays `"HH:MM"`.** The column becomes `time`; the API surface, the Zod
schemas and every component keep the string. That confines the change to the
Prisma boundary — serialisation in, parsing out — and leaves `timeHHmm` doing
exactly the job it does today. The alternative (a `Date`-shaped or minutes-since-
midnight wire format) would push the change through all 53 files and every
component test for no gain the constraint needs.

Pre-production means no data migration: the column converts in place with a cast.

---

## 7. The two acceptance bullets #297 still had open

#298's decision comment answered #297's first two bullets — the rule, and the
mechanism — without ever answering its third and fourth. Both are answered here,
and both turned out to be measurable rather than arguable.

### 7.1 Which of the four indexes change, and what happens to the tests pinning them

All four change. They are all in
`prisma/migrations/20260811202634_teacher_slot_unique_indexes/`:

| Index | Predicate today | Under the extraction |
|---|---|---|
| `Class_teacher_slot_unique` | `(teacherId, date, startTime) WHERE status <> 'cancelled'` | **dropped** — its columns leave the table |
| `StudioClass_teacher_slot_unique` | `(teacherId, date, startTime) WHERE cancelledAt IS NULL` | **dropped** — same |
| `ClassTemplate_teacher_slot_unique` | `(teacherId, dayOfWeek, startTime) WHERE isArchived = false` | **merged** into the one `ScheduleRule` exclusion constraint |
| `StudioClassTemplate_teacher_slot_unique` | same, other table | **merged** into the same constraint |

Net on the slot invariant: **4 partial unique indexes + 8 triggers → 2 exclusion
constraints.** All four are replaced by something strictly stronger — range
rather than instant (§4.4), and cross-family by construction rather than by
trigger. The two `@@unique([templateId, date])` indexes likewise become one
`UNIQUE (scheduleRuleId, date)` on `CalendarEntry`.

`src/services/slot-constraints.test.ts` (731 lines) is rewritten rather than
edited, and its cases fall into four groups:

- **Same-family slot cases** (the four `*_teacher_slot_unique` describes,
  `:93`–`:201`) — **ported**, re-pointed at `CalendarEntry` / `ScheduleRule`.
  Their assertions survive unchanged in meaning: a second live entry on an
  occupied slot is still refused, a cancelled one still does not block, an
  archived rule still frees its slot, another teacher is still unaffected.
- **Cross-family cases** (`:252`–`:731`) — **ported and merged into the
  same-family ones.** Under one table the distinction stops existing, which is
  the point of the work. The mutations they encode (moving by date, moving by
  start time, un-cancelling into an occupied slot, un-archiving into an occupied
  slot, a paused-but-unarchived rule still holding its slot) all survive as
  cases against the new constraint.
- **`Room identity indexes`** (`:202`–`:251`) — **untouched.** They share the
  file, not the subject.
- **The four "leaves a pre-existing violating pair editable on unrelated
  columns" cases** (`:310`, `:461`, `:684`, `:708`) — **deleted, because the
  state they construct becomes unconstructible.** See §7.2.

  Four, not two: an earlier draft counted only the instance-level pair, because
  it was written before §2.2(f) gave the **rule** layer an exclusion constraint
  too. Under the exact-start unique index that §2.2(f) replaced, the two
  template-level cases would have survived intact. The correction reached §4.4
  and did not reach this census — the same fix-in-one-place-not-its-twin defect
  `.claude/skills/solve-issue` §4 exists to catch, committed inside the document
  that describes it.

New cases the current file cannot express, and which the port must add:

- the half-open boundary at **both** layers — back-to-back legal, one minute
  earlier refused (§4.2 row 2, §4.4 row 3);
- the midnight-spanning collision (§4.3), and its rule-layer counterpart, which
  the constraint deliberately does **not** catch (§4.4, "What this does not
  reach") — a pinned non-refusal, so the blind spot is recorded rather than
  discovered;
- duration-only edits that create or resolve an overlap, at both layers;
- an overlapping *rule* pair refused at edit time, which is the behaviour change
  §2.2f introduces and the one case with no ancestor in the current file.

### 7.2 Grandfathering: there is none, and it is not a choice

#297 asks "whether an overlap that already exists in a teacher's schedule is
refused on next edit, or grandfathered". Under #296's triggers grandfathering
exists and is deliberate — the triggers fire on write, so a pre-existing
violating pair simply persists and stays editable on unrelated columns, which is
what `slot-constraints.test.ts:310` and `:461` pin.

**An exclusion constraint cannot offer that, and there is no escape hatch.**
Measured:

```
ALTER TABLE e ADD CONSTRAINT e_excl EXCLUDE USING gist (…);   -- over a violating pair
ERROR:  could not create exclusion constraint "e_excl"        -- 23P01

ALTER TABLE e ADD CONSTRAINT e_excl2 EXCLUDE USING gist (…) NOT VALID;
ERROR:  EXCLUDE constraints cannot be marked NOT VALID
```

So the answer is structural: **the migration either builds or aborts.** A
violating pair cannot survive it, and cannot be created afterwards.

That is acceptable here, and the reason is measured rather than assumed — the
current database would build it cleanly:

```sql
-- 32 live Class + 8 live StudioClass rows; overlapping live pairs across both families:
WITH e AS (SELECT "teacherId", date, "startTime"::time t, "durationMinutes" d, id FROM "Class" WHERE status <> 'cancelled'
           UNION ALL
           SELECT "teacherId", date, "startTime"::time, "durationMinutes", id FROM "StudioClass" WHERE "cancelledAt" IS NULL),
     s AS (SELECT *, tsrange(date+t, date+t+(d*interval '1 minute'), '[)') span FROM e)
SELECT * FROM s a JOIN s b ON a."teacherId"=b."teacherId" AND a.id<b.id AND a.span && b.span;
--  (0 rows)
```

**Zero overlapping live pairs.** (#297 recorded 31 live `Class` rows; it is 32
now, drifted by one since it was written.) The app is pre-production, so this is
the only database that matters and there is no backfill to design.

**The rule layer needs the same check, and passes it too.** §4.4's exclusion
constraint is a behaviour change — rule pairs that are legal today become
refusals — so it can abort on data that the current schema happily holds. The
same query against the two template tables, keyed on `dayOfWeek` and a minutes
range:

```sql
WITH r AS (SELECT id, "teacherId", "dayOfWeek" dow, "startTime"::time st, "durationMinutes" dur FROM "ClassTemplate" WHERE "isArchived"=false
           UNION ALL
           SELECT id, "teacherId", "dayOfWeek", "startTime"::time, "durationMinutes" FROM "StudioClassTemplate" WHERE "isArchived"=false),
     x AS (SELECT *, int4range((EXTRACT(HOUR FROM st)*60+EXTRACT(MINUTE FROM st))::int,
                               (EXTRACT(HOUR FROM st)*60+EXTRACT(MINUTE FROM st))::int + dur, '[)') slot FROM r)
SELECT * FROM x a JOIN x b ON a."teacherId"=b."teacherId" AND a.dow=b.dow AND a.id<b.id AND a.slot && b.slot;
--  (0 rows)     -- against 5 live ClassTemplate + 1 live StudioClassTemplate
```

**The plan must carry both queries as stop conditions**, because they are the
two steps that can fail on data rather than on code: if either returns rows at
implementation time, its migration aborts, and the resolution is a decision
about *those specific rows* — not a weakening of the constraint.

The rule-layer query is the more likely of the two to start returning rows,
because seeding and manual testing create templates far more freely than the 6
live rows above suggest. It should be re-run immediately before the migration is
written, not trusted from this document.

**And its zero is much thinner than the entry layer's.** The entry query has
something to chew on: 40 live rows, and two genuine same-teacher-same-day
clusters (09:00 +75 against 11:00; 14:00 +90 against 18:00) that legitimately do
not overlap — so a zero there is a result. Of the 6 live rules, only one teacher
holds two, and those sit on different `dayOfWeek` values, so the overlap
predicate is never actually exercised. **The rule-layer zero is close to
vacuous** — it says the constraint will build, and almost nothing about whether
the query would notice a violation. Seed a deliberate overlap and watch the
query return it before relying on the clean run (the plan's Task 2 Step 3 does
exactly this against the pre-flight `RAISE EXCEPTION`).

**One consequence worth stating plainly:** a conforming row stays freely
editable on unrelated columns. Measured — an `UPDATE` that does not change
`date`, `startTime`, `durationMinutes` or `cancelledAt` does not re-check and
cannot self-conflict. Only an edit that moves the span, or revives a cancelled
row, is tested.

---

## 8. Issue consequences

| Issue | Effect | Why |
|---|---|---|
| #296 | **withdrawn on landing** — already closed; its eight triggers are deleted | the invariant becomes an index-backed composite FK |
| #297 | **closed by this decision** | overlap is the constraint, not a follow-up |
| #205 (`StudioClass` has no `(teacherId, date)` index) | **withdrawn on landing** | the per-family occupancy scan stops existing |
| #210 (`isUniqueConflictOn` cannot tell the models apart) | **shrinks** | four same-shaped indexes become one |
| #284 (studio generation becomes week-keyed) | **shrinks, not withdrawn** | rule 2 dissolves into one generator (§2.3); rule 4 is product behaviour that still has to be written |
| #288 / #291 (`SkipReason`, `SkipCounts`) | **shrinks** | `blocked_by_other_family` becomes the overlap reason — a rename (§4.4) |

Recorded as rejected, at both layers: **single table with a discriminator.**

---

## 9. Left explicitly out

**`location` does not move to `CalendarEntry`.** Two classes in different rooms
are still impossible for one teacher, so place is not part of the exclusivity
predicate. And `teacherRoomId` versus free-text `location` reads as a real
difference between a rented room and a studio booking, not an accident to be
smoothed over.

**A buffer between classes** (#297's second option). Rejected in §1; if it is
ever wanted, it is an adjustment to the span expression on one table, which is
a considerably cheaper change to make later than it would have been before this
extraction.

**Merging the two lifecycle triads.** Option D's prize, and separable from the
schema work — with one qualification the census could not show. The triads are
parallel in two of three operations and not in the third:
`generationState`/`firstFreeWeek` appears 9 times in `class-template-
lifecycle.ts` and 0 times in `studio-class-template-lifecycle.ts`, because the
#194 first-reachable-week behaviour is class-only. `pauseOrResume` and
`archiveOrUnarchive` are ready to merge as soon as `ScheduleRule` exists —
the studio file already imports `LastScheduledClass` from its twin. **`update`
is blocked on #284**, which decides whether the studio family gains that
machinery at all.

**Totality.** Nothing forces a `CalendarEntry` to have a child. Parent and child
are written in one transaction; a constraint would need a deferred check for no
benefit this work needs.

---

## 10. Sequencing: the release trigger has fired

#298's sequencing comment set the trigger at **the close of #283 and #276**,
amending an earlier proposal of "#284". Re-derived:

```
gh issue view 283 --json state,stateReason   # CLOSED | COMPLETED  (PR #303)
gh issue view 276 --json state,stateReason   # CLOSED | COMPLETED  (PR #306)
```

Both closed. The hold is released, and both of its stated reasons are
discharged: #283's e2e coverage now nets the six studio screens the extraction
rewrites, and #276 settled whether a studio class's `date` is editable — which
is what decides whether `CalendarEntry.date` is mutable for `kind = 'studio'`.
It is: forwards only, and only on a manually logged row.

`docs/lock-order.md` §"The cross-family slot guard reads, and does not lock
(#296)" says to **reopen** the advisory-lock question if this issue slips
materially past #283 and #276. It has not slipped; that section is confirmed
rather than reopened, and #296's accepted residual race stays accepted for the
remaining window.

---

## 11. Carried into the plan

1. Migration order, and the fact that data moves before the constraint is added.
2. A written verdict for each of the 14 SQL liveness predicates (§5.3).
3. The `startTime` boundary decision (§6) — wire format stays `"HH:MM"`.
4. The overlap pre-check as a stop condition (§7.2).
5. The `slot-constraints.test.ts` port, group by group (§7.1), including the
   three case classes the current file cannot express.
6. `api/studio-classes/[id]/route.ts:143`'s re-entry comment, whose scope widens.
7. Which of the two generators survives, and the week-keying that lands with it.
8. The `ScheduleRule` exclusion constraint (§4.4) — a behaviour change, not a
   port: rule pairs that are legal today become refusals, so the two template
   forms need the 409 wording and a test that the refusal is reachable from the
   UI, not only from the database.
9. **The two end-instant call sites** (§2.2a). `class-lifecycle.ts:550` and
   `class-transitions.ts:532` each read `date`, `startTime`, `durationMinutes`
   and `teacher.defaultTimezone` off a single `Class` row; the extraction moves
   three of those four to `CalendarEntry`, so both need a join. The first is
   evaluated **inside `completeClass`'s row lock**, which makes it a lock-order
   question rather than a query rewrite — reading a second table while holding
   `FOR UPDATE` on the first. `docs/lock-order.md` governs it, and it belongs to
   the entry-layer plan, not the rule-layer one.

# Room archive lifecycle — Design Spec

Issue 76 · 2026-08-18

## 1. What the issue asked, and what is actually true

*Line references in sections 1 and 2 were measured against the pre-branch
tree and describe the defect as it stood; they are deliberately NOT repointed,
because the code they name has since moved or been replaced and rewriting them
would turn a record of what was measured into a claim about what now exists.
The end-state citations — section 4's door table, section 10 — are live, and
were re-derived after fix round 2, whose own insertions had silently pushed
four of them off their targets.*

Issue 76 ("Room deletion is blocked forever by cancelled and completed
classes") presents three options and recommends the third — *archive instead of
delete*, using "the unused `TeacherRoom.isArchived`".

**Archiving already shipped, three and a half months before the issue was
filed.** Commit `e57b8bd`, "feat: rooms management with search, create, edit,
archive", 2026-04-05 21:23 +0200. Issue filed 2026-07-24 13:50Z.

| Surface | Location |
|---|---|
| `PATCH /api/teacher-rooms/[id]?state=archived\|unarchived` | `src/app/api/teacher-rooms/[id]/route.ts:66` |
| `ArchiveRoomButton`, rendered unconditionally | `src/app/(teacher)/settings/rooms/[id]/page.tsx:129` |
| `/settings/rooms` filters `isArchived: false` | `src/app/(teacher)/settings/rooms/page.tsx:11` |
| `/settings/rooms/archived` shows the rest | `src/app/(teacher)/settings/rooms/archived/page.tsx:10` |

`c94a621` later gated the delete button on `isArchived`
(`settings/rooms/[id]/page.tsx:136`), so **archive-then-delete is already the
deliberate lifecycle** — the issue's own words, "hard deletion reserved for
rooms that were never used."

### Three of the issue's claims do not hold

1. **"`TeacherRoom.isArchived` … is currently unused by this route."** Narrowly
   true of `DELETE /api/rooms/[id]`, but the sentence reads as *unused*, and
   `docs/backlog-roadmap.md:1891` copied it that way ("archive via the unused
   `TeacherRoom.isArchived`"). It has four consumers, listed above.

2. **"stuck with that room in their list permanently."** False. Archiving
   removes the room from `/settings/rooms`. Only hard *deletion* stays blocked,
   which is option 3's intended outcome rather than a defect.

3. **The issue quotes one delete route; there are two.**
   `DELETE /api/teacher-rooms/[id]:123` already answers **409 "Cannot delete a
   room with class history. Archive it instead."** That is option 1's reword,
   already applied, pointing at option 3's mechanism. The unfiltered
   **400 "Cannot delete a room that has classes"** the issue quotes is on the
   *other* route (`src/app/api/rooms/[id]/route.ts:37-39`) — **that quoted
   wording describes the pre-branch state; §7 aligns it to the sibling's 409**
   — and
   `settings/rooms/[id]/page.tsx:130,136` gates both destructive buttons on
   `classCount === 0`, so a teacher barely reaches it.

## 2. The defect that is actually there

**`TeacherRoom.isArchived` is a display flag with no downstream meaning.** It
decides which of two list pages a row appears on. Nothing else reads it.

Measured consequences, all live today:

- **A room can be archived while an open class or a live recurring template
  still points at it.** The PATCH handler does three things — ownership check,
  idempotency check (`route.ts:90`, from issue 98), flip the boolean. No class
  count, no template lookup.
- **A live template keeps generating into an archived room, indefinitely.**
  `src/services/class-generator.ts:359` selects
  `{ isActive: true, isArchived: false }` on the *template*; it uses
  `template.teacherRoomId` at `:185` and never joins `TeacherRoom`. The room's
  archive state is invisible to the generator.
- **Resuming a paused template into an archived room succeeds silently.**
  `pauseOrResumeTemplate` (`src/services/class-template-lifecycle.ts:697`)
  checks exists → ownership → already-in-state → `template.isArchived`
  (`:727`). There is no room check, and `PauseTemplateResult` (`:534`) has no
  room-shaped member. Resume generates instances inside the same transaction.
- **Archived rooms are still offered when scheduling.**
  `GET /api/teacher-rooms` (`src/app/api/teacher-rooms/route.ts:17`) does not
  filter `isArchived`, and neither picker filters client-side
  (`src/app/(teacher)/class/new/page.tsx:169`,
  `src/components/settings/template-form.tsx:152`).

### Why it happened

The spec that shipped archiving — `docs/superpowers/specs/2026-04-05-rooms-management-design.md`,
119 lines, sections for the list page, the edit page, the add flow, the API —
**never mentions archive**, despite the commit title naming it. The feature
arrived undefined, so it came to mean exactly what the one page using it
needed. Contrast `ClassTemplate.isArchived`, which is engineered: archiving
forces `isActive: false`, withdraws future unbooked classes, records
`archivedAt` and `withdrawnCount`, and appears in the generator's `where` as
documented defense-in-depth (`class-generator.ts:352-357`). Two columns of the same
name, one load-bearing and one cosmetic.

## 3. The rule

> A room may not be archived while it is **in use**, and an archived room
> accepts **no new commitments**. Unarchiving is always allowed.

**In use** means, on the teacher's own `TeacherRoom` link:

- a class in status `open` or `in_progress`; **or**
- an active template, `{ isActive: true, isArchived: false }`.

`draft` classes, `completed`/`cancelled` classes, paused templates and archived
templates do **not** block. The `completed`/`cancelled` exclusion is the
issue's actual ask.

Unarchiving is unconditional. That is the release valve which makes every
refusal below recoverable in one action.

**Scope note, load-bearing and otherwise invisible:** the blockers query is
scoped by `teacherRoomId`, and `TeacherRoom` is per-teacher. A shared room
archived by teacher A is unaffected by teacher B's classes and templates.
Archiving is a private act on a private link, never on the `Room`.

## 4. The five doors

| # | Door | Rule | Where the guard goes |
|---|---|---|---|
| 1 | Archive the room | refuse if in use (§3) | new `src/services/room-archive.ts`, called by `PATCH /api/teacher-rooms/[id]` |
| 2 | Publish `draft → open` | refuse if room archived | the existing `if (targetStatus === 'open')` block, `src/services/class-lifecycle.ts:303` |
| 3 | Resume template `paused → active` | refuse if room archived — **the resume direction only** | `pauseOrResumeTemplate`, beside the `reason: 'archived'` return at `class-template-lifecycle.ts:767` |
| 4 | Create a template | refuse if room archived | `POST /api/class-templates` |
| 5 | Move a template's `teacherRoomId` | refuse if room archived — **only while the template is active** | `updateClassTemplate`, `class-template-lifecycle.ts`, surfaced by `PUT /api/class-templates/[id]` |

Door 4 exists because `ClassTemplate.isActive` defaults `true`
(`prisma/schema.prisma:336`) — a template created on an archived room begins
generating immediately.

There is no door for creating a *class* on an archived room: a new class is
always born `draft` (`src/app/api/classes/route.ts:80`), and door 2 catches it
at publish. A parked draft on an archived room is harmless and deliberately
permitted. Nor is there a class-shaped door 5: `teacherRoomId` is absent from
`TeacherEditableClassField` (`class-lifecycle.ts:703-713`), so a class's room
is immutable after creation and no edit can move an `open` class onto an
archived room. Recorded because door 5 exists precisely where nobody had asked
the *move* question — asking it of classes too, and answering it from the
allowlist, is what makes the "every path a teacher can reach" claim below
checkable rather than asserted.

**Door 3 guards one direction, not the verb.** Pausing a template whose room is
archived must keep working, so the check is gated on the resume direction, not
on the room's state alone — `active → paused` is a real transition that does
not hit the already-in-state short-circuit and would otherwise be refused.

This is load-bearing rather than tidy. An *active* template on an archived room
used to be described as reachable only through the accepted race in §8: door 1
refuses archiving while an active template exists, door 4 refuses creating one
there, and door 3 refuses resuming into one. That enumeration missed a fourth,
fully deterministic route — moving an already-active template's
`teacherRoomId` onto an archived room, which none of those three doors
touched — closed only in fix round 2 (`updateClassTemplate`, gated on
`template.isActive` the same way door 3 is; issue 76). With that guard, the
doors close every path a teacher can reach through the app. What remains is
outside their reach, not a hole in them: the generator, which does not read
the room's archive state at all and keeps producing into a room a template was
left active on (§10), and a row already archived before this branch, back when
`isArchived` meant nothing. Both are recoverable the same way — pausing —
which is why the guard stays on the resume direction and not the room's state
alone: a guard on the room's state alone would remove it, leaving a teacher
unable to stop a template still generating classes into a room they had
shelved.

### The template predicate must not be invented

Door 1's template clause and the generator's own template selection ask the
same question — "would this template put classes into this room?" — so they
must not be able to answer it differently.

**Agreement is structural, not asserted.** Both import `ACTIVE_TEMPLATE_WHERE`
from a new import-free `src/lib/template-selection.ts`: `room-archive.ts` for
the blocking count, `class-generator.ts:369` for its `findMany`. Divergence is
therefore impossible rather than merely detectable, and no test is needed to
police it.

*(An earlier draft of this section had the two predicates written out
separately, with a test asserting they matched by reading the generator's
source text. That is superseded: sharing the constant is strictly stronger and
retires the source-matching test. Changed during the pre-flight scan, before
implementation.)*

The constant lives in `lib/` rather than in `class-generator.ts` because the
generator value-imports `@/lib/log` (pino, server-only); a constant sourced
from there would drag pino into every importer's graph. This is the
`lib/tiers.ts` / `lib/class-fields.ts` pattern CLAUDE.md documents, and the
hazard it guards against is a real one in this codebase.

## 5. The service

`src/services/room-archive.ts` — framework-agnostic, no HTTP concerns, no
framework imports, per CLAUDE.md's services rule. It mirrors the discriminated
shape `pauseOrResumeTemplate` already returns — specifically **one union member
per reason**, not one member carrying a multi-literal `reason` field.

That distinction is load-bearing, not cosmetic. TypeScript narrows *which
member* a discriminant check selects, not the property type inside a member, so
a packed member can never be exhausted by the `if (result.reason === …) return`
chain every route in this codebase uses — the closing `const unhandled: never`
guard fails to compile with every case already handled. The first draft of this
service packed them, and the route had to work around it with a `switch`; the
type was split instead.

```ts
export type ArchiveRoomResult =
  | { ok: true; action: 'archived' | 'unarchived' | 'unchanged'; isArchived: boolean }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'in_use'; blockers: { classes: number; templates: number } };

export async function setTeacherRoomArchived(
  db: PrismaClient,
  teacherRoomId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveRoomResult>;
```

The route keeps its current observable behaviour and becomes a thin wrapper:
ownership → 403, missing → 404, already-in-target-state → the existing
no-write `action: 'unchanged'` response (issue 98's rule: a retry after a lost
response must not undo what the first attempt did), and the new `in_use` → 409.

`in_use` is a 409, matching the sibling `DELETE` at `teacher-rooms/[id]:123` —
a conflict with current state, not a malformed request.

### The refusal names what blocks it

Not "room in use". The message reports the counts it measured, so the teacher
knows what to clear:

- `2 upcoming classes and 1 recurring class still use this room.`
- `1 upcoming class still uses this room.`
- `1 recurring class still uses this room.`

Singular/plural handled per count; the two clauses join with "and" only when
both are non-zero. This follows the house style of naming the way out, as
`DUPLICATE_ROOM` and `NOW_SHARED` do in `src/app/api/rooms/[id]/route.ts`.

Doors 2 and 3 return prose in the same spirit: *"This room is archived. Unarchive
it to publish classes here."* and *"This room is archived. Unarchive it to resume
this recurring class."*

## 6. Pickers

`GET /api/teacher-rooms` is **unchanged**. It returns the teacher's rooms;
*which are selectable* is UI policy, not API policy, and changing the response
shape would silently narrow the list for any future caller.

Both pickers filter `isArchived` client-side:

- `src/app/(teacher)/class/new/page.tsx:169` — create-only, plain filter.
- `src/components/settings/template-form.tsx:152` — used in **both** `create`
  and `edit` mode (`src/app/(teacher)/settings/recurring/[id]/page.tsx:34`), so
  it must keep the **currently-selected** room in the list even when archived.
  Otherwise editing a paused template on an archived room silently loses its
  room selection.

Nothing depends on this filter for correctness. Doors 2 and 4 are the
enforcement; the filter is feedback that arrives earlier.

**The filter changes an empty state, and that copy has to change with it.**
Both pickers fall back to "No rooms configured — add a room in Settings" when
the list is empty. Filtering archived rooms out means a teacher whose rooms are
*all* archived reaches that screen and is told to add a room they already own.
The all-archived case gets its own message naming un-archiving as the way out.
This is a defect the filter introduces rather than one it reveals, so it is
fixed alongside it.

## 7. Three residues folded in

1. **`src/components/settings/unlink-room-button.tsx:50`** promises "Classes
   using this room will also be removed." The route it calls refuses with 409
   when classes exist — it never removes classes. The copy describes a cascade
   that cannot happen. Corrected to state that unlinking is only possible when
   no classes exist.

2. **`src/app/api/rooms/[id]/route.ts:39`** answers **400 "Cannot delete a room
   that has classes"**, implying a clearable condition, while its sibling
   answers **409 "…Archive it instead."** Aligned to the sibling in both status
   and wording. This is issue 76's option 1, applied to the one route that
   never received it.

3. **`settings/rooms/[id]/page.tsx:31`** computes `classCount` at server render
   and `:130,136` gate the destructive buttons on it. That is a server snapshot
   which can go stale. A `known-open` comment records it beside the gate rather
   than a lock — same treatment `template-sync` gets in CLAUDE.md.

## 8. The accepted race

Door 1 reads its blockers, then flips the flag. A class published in another
tab between those two steps leaves an archived room holding an `open` class.

**This is accepted and documented, not closed.** The precedent is written two
doors away, in the publish guard this spec extends
(`class-lifecycle.ts:298-302`): *"The refusal is a policy about intent, not an
invariant, so a millisecond of staleness costs a wrong answer rather than a
broken one."*

The reasoning carries over. Losing the race needs two tabs; the resulting state
is recoverable by unarchiving and self-heals when the class completes; and the
alternative is a new `FOR UPDATE` node in a lock ordering that
`src/services/template-lock-order.test.ts` exists to defend, placed in the
publish path of every class in the room.

**Wrapping the archive in a transaction is explicitly rejected as illusory.**
Under read-committed the blocker query does not lock the class or template
rows, so a concurrent publish still slips between the check and the flip. It
would read as protection while providing none.

A comment at the guard records this as `known-open`.

## 9. Testing

Door 1 is one door with an **OR of two independent predicates**
(`hasBlockingClass || hasActiveTemplate`). A fixture that trips both clauses at
once certifies neither — the class clause short-circuits, and the template
clause could be deleted outright with the suite green. **Each disjunct needs a
fixture that isolates it.**

### Door 1, class clause — fixtures carry no template

| Fixture | Expected |
|---|---|
| `open` class | refused |
| `in_progress` class | refused |
| `draft` class only | archives |
| `completed` + `cancelled` only | archives — the issue's actual ask |

### Door 1, template clause — fixtures carry no blocking class

| Fixture | Expected |
|---|---|
| active template (`isActive: true, isArchived: false`) | refused |
| paused template (`isActive: false`) | archives |
| archived template (`isActive: true, isArchived: true` — **not** `isActive: false`; see mutation 3) | archives |

The paused case is what stops the clause being written as "any template
exists", which would re-block the room permanently and reintroduce issue 76's
original complaint one layer up.

### Mutations — each proven to fail independently

Per CLAUDE.md and the solve-issue skill: break it, record the exact error text,
restore, re-verify. A guard that compiles but cannot fail certifies nothing.

| # | Mutation | Must go red | Must stay green |
|---|---|---|---|
| 1 | Delete the template clause from door 1 | active-template test | every class test |
| 2 | Delete the class clause from door 1 | open-class test | every template test |
| 3 | Narrow the template predicate to `{ isActive: true }` | archived-template test — **only if its fixture is `isActive: true`**. An `isActive: false` fixture is excluded by the `isActive` half regardless, so it cannot isolate the `isArchived` half and leaves this mutation undetected. | — |
| 4 | Widen the class predicate to include `draft` | draft-only test | — |
| 5 | Invert door 2's `isArchived` check | publish-into-archived test | — |
| 6 | Invert door 3's `isArchived` check | resume-into-archived test | — |
| 7 | Remove door 4's room check | create-template-on-archived test | — |
| 8 | Remove door 5's `teacherRoom.isArchived` check | move-active-template-onto-archived test | the paused-move test |
| 9 | Drop `&& template.isActive` from door 5 | the paused-move test — the only case in the suite that can catch it | the move-active test |

**Mutations 1 and 2 are the ones that matter.** If either can be applied with
the suite staying green, the isolation failed and the fixtures are wrong.

### Pinning the shared constant

No agreement test is needed — sharing `ACTIVE_TEMPLATE_WHERE` makes divergence
impossible (§4). What is pinned instead is the constant's own **value**, so
that widening or narrowing it is a deliberate act with both call sites in view
rather than a one-word edit in passing.

The sharing itself is proved structurally: changing one key in
`lib/template-selection.ts` must redden three separate files — the constant's
own test, the archive guard's template cases, and the generator's tests. If the
generator's tests stay green, the two sides are not actually sharing.

### Also covered

- `PATCH ?state=unarchived` on an in-use room succeeds — unarchiving is
  unconditional, and this is the release valve the refusals depend on.
- The idempotent no-write path (issue 98) still returns `action: 'unchanged'`
  without touching the row, including on a room that is in use.
- `TemplateForm` in `edit` mode retains an archived currently-selected room in
  its picker.
- The plural/singular branches of the blockers message.

## 10. Out of scope

- **Issues 52 and 259 are unaffected.** Neither is touched by this branch.
- **No migration — but the column acquires new meaning over existing data.**
  `TeacherRoom.isArchived` already exists (`prisma/schema.prisma:298`) and
  nothing about the schema changes, which is true and is the whole of what "no
  migration" means for the column itself. It is misleading about the
  *semantics*, though: before this branch `isArchived` was a display flag read
  by nothing (`room-archive.ts`'s header), so a row already `true` was
  archived in name only — an active template could already sit on it, and
  every doorway this branch adds now treats that same row as meaning
  something. No backfill reconciles the two; a room archived before this
  branch keeps whatever an active template was already doing on it (see
  below).
- **The generator does not read the room's archive state.**
  `class-generator.ts:368-371` selects templates on `ACTIVE_TEMPLATE_WHERE` —
  the template's own `isActive`/`isArchived` — and never consults
  `teacherRoom.isArchived`; generated instances are written directly with
  `status: 'open'` (`class-generator.ts:200`), bypassing `transitionClass`
  entirely, so door 2 cannot see them either. A template already active on a
  room archived before this branch — back when the flag meant nothing — keeps
  generating into it, indefinitely, through this branch. Closing that is a
  product decision (auto-pause on archive? refuse the sweep per-instance and
  log?), not a bug this branch's doors can reach — none of the five checks a
  room's state at generation time, only at the moment a teacher commits to it.
  No migration and no backfill. Recorded as `known-open` at
  `class-generator.ts:359-367`, immediately above the read it describes —
  line numbers re-derived after fix round 2, whose own ten-line insertion is
  what pushed the read down and falsified the previous citation.
- **No change to what archiving does to existing drafts or paused templates.**
  They survive on the archived room and are stopped at their own doors.
- **Studio templates are untouched.** `StudioClass` is disconnected from
  `Room` per CLAUDE.md, so `StudioClassTemplate` has no `teacherRoomId`.
- **No lock.** See §8.
- **The `Room` row left behind** when every `TeacherRoom` link to a private room
  is archived is not addressed. It is invisible to users and costs nothing.

## 11. References, verified 2026-08-18

Every line number above was re-derived with `grep -n` at spec time rather than
carried from earlier reading. **Five had drifted** from the working notes and
were corrected here:

| Cited as | Actually |
|---|---|
| `unlink-room-button.tsx:47` | `:50` |
| `class-template-lifecycle.ts:726` | `:727` |
| `settings/rooms/[id]/page.tsx:135` (`ArchiveRoomButton`) | `:129` |
| `PauseTemplateResult` at `:569` | declared at `:534` (`:569` is one member) |
| `waitlist-retention.ts:75` as the agreement precedent | that line only *describes* the precedent; the test itself is `class-terminal-date.test.ts:170` |

The last two were caught by the spec self-review, not the first sweep — the
first sweep verified the references it had already written down, and those two
entered the document during writing. **Verifying a reference list does not
verify references added after it.**

An implementer should re-verify before editing and report any further drift.

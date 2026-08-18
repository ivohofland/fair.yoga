# Room archive lifecycle — Design Spec

Issue 76 · 2026-08-18

## 1. What the issue asked, and what is actually true

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
   *other* route (`src/app/api/rooms/[id]/route.ts:37-39`), and
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
  `src/services/class-generator.ts:355` selects
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
documented defense-in-depth (`class-generator.ts:351`). Two columns of the same
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

## 4. The four doors

| # | Door | Rule | Where the guard goes |
|---|---|---|---|
| 1 | Archive the room | refuse if in use (§3) | new `src/services/room-archive.ts`, called by `PATCH /api/teacher-rooms/[id]` |
| 2 | Publish `draft → open` | refuse if room archived | the existing `if (targetStatus === 'open')` block, `src/services/class-lifecycle.ts:303` |
| 3 | Resume template `paused → active` | refuse if room archived | `pauseOrResumeTemplate`, beside the `reason: 'archived'` return at `class-template-lifecycle.ts:727` |
| 4 | Create a template | refuse if room archived | `POST /api/class-templates` |

Door 4 exists because `ClassTemplate.isActive` defaults `true`
(`prisma/schema.prisma:336`) — a template created on an archived room begins
generating immediately.

There is no door for creating a *class* on an archived room: a new class is
always born `draft` (`src/app/api/classes/route.ts:80`), and door 2 catches it
at publish. A parked draft on an archived room is harmless and deliberately
permitted.

### The template predicate must not be invented

Door 1's template clause uses `{ isActive: true, isArchived: false }` —
**byte-identical to the generator's own selection predicate**
(`class-generator.ts:355`). "Would this template put classes into this room?"
is precisely the question the generator asks, so any divergence is a bug by
construction. A test pins the two in agreement, following the precedent in
`src/services/class-terminal-date.test.ts:170`, which drives its cases from
`TERMINAL_CLASS_STATUSES` itself with `it.each` rather than from a hand-written
list that could silently fall behind.

## 5. The service

`src/services/room-archive.ts` — framework-agnostic, no HTTP concerns, no
framework imports, per CLAUDE.md's services rule. It mirrors the discriminated
shape `pauseOrResumeTemplate` already returns:

```ts
export type ArchiveRoomResult =
  | { ok: true; action: 'archived' | 'unarchived' | 'unchanged'; isArchived: boolean }
  | { ok: false; reason: 'not_found' | 'forbidden' }
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

**Mutations 1 and 2 are the ones that matter.** If either can be applied with
the suite staying green, the isolation failed and the fixtures are wrong.

### Predicate-agreement test

A test pinning door 1's template `where` against `class-generator.ts:355`, so
the two cannot drift apart silently.

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
- **No migration.** `TeacherRoom.isArchived` already exists
  (`prisma/schema.prisma:298`); nothing about the schema changes.
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

# Studio class deletion: the door that already exists, and the one that should

> **Line numbers are as of `main` at `ab513bc`**, before this branch. Two of
> them name code this branch changes: `prisma/schema.prisma:488` (the false
> sentence §1.5 corrects) and `src/app/(teacher)/studio-class/[id]/page.tsx:60`
> (the dead end §6 replaces). Every other citation describes code this branch
> leaves alone.

Issue 279 — a decision issue, labelled `question`, parented to the studio-family
tracker 274. Its acceptance asks for a written answer, and says that a "yes"
answer "comes with the route, the ownership check and the audit trail". This
spec is that answer, and the branch it implies.

---

## 1. What the issue claimed, and what was measured

### 1.1 Held, exactly: there is no `DELETE` route for either studio model

The studio family exports nine route handlers and none of them is a `DELETE`:

| File | Handlers |
|---|---|
| `src/app/api/studio-class-templates/route.ts` | `GET`, `POST` |
| `src/app/api/studio-class-templates/[id]/route.ts` | `GET`, `PUT`, `PATCH` |
| `src/app/api/studio-classes/route.ts` | `GET`, `POST` |
| `src/app/api/studio-classes/[id]/route.ts` | `GET`, `PUT` |

`2 + 3 + 2 + 2 = 9`, of which `DELETE` = 0.

### 1.2 Held, exactly: eight `DELETE` handlers exist, and which they are

`grep -rn "export const DELETE\|export async function DELETE" src/app/api`
returns eight, and the issue names all eight correctly:
`waitlist/[id]`, `auth/session`, `teacher-links/[teacherId]`,
`teacher-rooms/[id]`, `rooms/[id]`, `account`, `registrations/[id]`,
`invitations/[id]`.

The issue's count is right and its list is right. Recorded because it is
unusual — §1.4 and §1.5 are not.

### 1.3 Held: the two terminal states, and their reversibility

- `StudioClassTemplate` → archived, reversible. Un-archive clears `archivedAt`
  and `withdrawnCount` and forces `isActive: false`, so the reverse of archived
  is *paused*, never *live*.
- `StudioClass` → cancelled, reversible **only by curl**.
  `updateStudioClassSchema` (`src/lib/schemas.ts:476`) accepts
  `cancelledAt: null`, and `src/app/api/studio-classes/[id]/route.ts` applies
  it — but `src/app/(teacher)/studio-class/[id]/page.tsx:60-64` renders a dead
  end reading `This class was cancelled.` with no action beside it.

### 1.4 WRONG: "no delete door, in either direction"

The title's claim is false. `archiveOrUnarchiveStudioTemplate` hard-deletes
`StudioClass` rows:

```ts
// src/services/studio-class-template-lifecycle.ts:1262
const { count: deleted } = await tx.studioClass.deleteMany({
```

keyed on `scheduledWhere` (`:664`), which is
`{ templateId, date, cancelledAt: null }`. So the studio family has **exactly
one delete door**, and it is:

- aimed at `StudioClass`, not at the template;
- triggered from the template's archive `PATCH`, not from any `DELETE` verb;
- bulk, future-only, and sparing of cancelled rows;
- unrecoverable — which is precisely why `withdrawnCount` exists to record what
  it removed.

**This reframes the question the issue asks.** It is not "should studio classes
be deletable at all" — the project decided that in #97 and shipped it. It is
"the one deletion that exists has a shape; should a single-row door share that
shape or contradict it".

### 1.5 WRONG, and inherited: "a cancelled studio class is an income record"

The issue's dilemma rests on this:

> A cancelled studio class is: an income record, if it happened — which argues
> for keeping it, and a typo, if the teacher logged the wrong date — which
> argues for removing it.

It is not an income record. `src/app/(teacher)/settings/reporting/page.tsx:36`
queries with `cancelledAt: null`, so cancelled rows are excluded from earnings
and from the month rollup outright. And `:52`:

```ts
const studioEarnings = (s) => (Number(s.hourlyRate) * s.durationMinutes) / 60;
```

`studentCount` never touches money at all — it feeds only the rollup's
"students" column.

The issue did not invent the claim. It inherited it from
`prisma/schema.prisma:488`, in the `withdrawnCount` docblock justifying why the
archive spares cancelled rows:

> An already-cancelled one is an income record and survives.

That sentence and `reporting/page.tsx:36` cannot both be true. §8.2 corrects it.

**The correction does not change the archive's behaviour**, and this branch does
not touch it. Sparing cancelled rows is still right; the *reason* is different.
See §3.

### 1.6 Held, but not studio-specific: "a struck-through card, forever"

True, and via `/schedule/past`, whose query is unbounded
(`src/app/(teacher)/schedule/past/page.tsx:17,30` — `date: { lt: today }`, no
status or cancellation filter). There is no retention sweep for either class
model; `waitlist-retention.ts` reaps `WaitlistEntry` only.

But a **cancelled `Class` litters that page identically** —
`src/components/schedule/class-list.tsx:49` derives `cancelled` from
`status === 'cancelled'` and `:96` strikes it through, exactly as `:122` and
`:133` do for a studio class. The asymmetry issue 279 describes between the two
families is real, and it is in the *vocabulary* (`ClassStatus` with five members
and a terminal freeze, versus one nullable timestamp), not in the litter.

---

## 2. The decision

> **A studio class may be removed when removal is stable — when nothing will
> recreate it.**
>
> **A `StudioClassTemplate` is never removed.** Archiving is its end state.

Deletability, in full:

| | future | past |
|---|---|---|
| **manual** (`templateId === null`) | removable | removable |
| **generated** (`templateId` set) | **refused, 409** — cancel instead | removable |

Cancellation state is orthogonal: a cancelled class follows the row it is
already in. A cancelled future generated class is refused; a cancelled past one
is removable.

---

## 3. What a cancelled studio class actually is

Following §1.5, the whole function of a cancelled `StudioClass` row is:

1. a private note that a planned class did not happen — with **no counterparty**.
   `StudioClass` has no registrations, no payments, no notifications, and
   `grep -rln "StudioClass\|studioClass" "src/app/(public)" "src/app/(student)"`
   returns nothing, so no one but the owning teacher can ever see it; and
2. a lock on `(templateId, date)` — `prisma/schema.prisma:535`, which ignores
   `cancelledAt`. It is **not** in the partial slot index
   `(teacherId, date, startTime) WHERE "cancelledAt" IS NULL`, so it does not
   block a manual re-log at the same time.

That is the asymmetry with `Class` that decides this issue. A cancelled `Class`
is a fact about *other people* — students registered, were notified, may have
paid. A cancelled `StudioClass` is a private diary entry about the teacher's own
gig. Nothing outside the teacher's own account is worse off if it goes.

**The corrected reason the archive spares cancelled rows** is (2), not income:
deleting them would release their `(templateId, date)` key inside a transaction
whose whole purpose is to withdraw a window, and a teacher who cancelled a date
deliberately would find it refilled on the next resume.

---

## 4. The stability rule, and why it is read off the generator

```ts
deletable(sc) ⟺ sc.templateId === null
              ∨ classStartInstant(sc.date, sc.startTime, tz) <= now
```

The second clause is not chosen. It is read off
`src/services/studio-class-generator.ts:138-143`:

```ts
const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
  .filter((date) =>
    classStartInstant(date, template.startTime, template.teacher.defaultTimezone) > startDate,
  )
  .slice(0, DEFAULT_WEEKS);
```

A candidate must have its start instant **ahead of now**. So a class whose start
has passed is never a candidate, and removing it cannot be undone by the sweep.

Conversely, removing a **future generated** class releases `(templateId, date)`
and the hourly sweep recreates it — within the hour, silently, forever. That is
the same failure mode issue 275's first comment used to rule out narrowing the
unique index to live rows, and it is why the door refuses rather than obliges:
a delete that quietly reverses itself reads as the app ignoring the teacher.

**Cancel is the correct operation on a future generated class**, and it already
exists.

### 4.1 The instant, not the date

The clause compares start *instants*, not calendar dates, so a class dated today
at 09:00 becomes removable at 09:00 and not at 08:00. This matches the
generator's filter exactly, which is the point — a day-granularity predicate
would call a class removable while the sweep still considered its date a
candidate, and the two would disagree in the window between local midnight and
the class's start.

The visible cost: a teacher looking at today's schedule sees a card with no
Remove action until the class has begun. Accepted, because the alternative is
the two predicates drifting — the exact hazard `studio-class-generator.ts:174-176`
already warns about for its own pre-check-versus-constraint pair.

### 4.2 The two things the predicate must NOT read

**Template state — `isActive`, `isArchived`.** It is tempting: an archived
template generates nothing, so a future generated class under one is "safe" to
remove. It is not, because **template state is reversible**. Un-archive →
resume → generation restarts, and a date released under the archived reading is
refilled. A predicate that reads reversible state is a predicate that can flip.

This is the same warning `src/services/room-deletion.ts:14-21` gives about its
own door — *"Narrowing this module's predicates to match the archive door's is
the single most likely wrong edit here: it compiles, it passes any test written
against a live template"* — one model over.

**`cancelledAt`.** Removability is about whether the sweep will bring it back,
and the sweep treats a cancelled own-row as occupancy either way
(`studio-class-generator.ts:166`, `blocked_by_cancelled`). Making cancellation a
precondition would force the teacher to create the litter before they could
clear it.

---

## 5. Forward constraint: what week-keying (#284) does to this

Issue 284's acceptance is explicit: *"No studio class is generated into a week
that already holds one from that template, cancelled ones included."* Occupancy
becomes per `(template, week)`, and a **past** class occupies its week exactly
as a future one does.

So after 284 lands, removing a past **generated** class can free that class's
week and let the sweep fill a still-future candidate in the same week. Worked
path, Europe/Amsterdam, Monday-start weeks (`src/lib/timezone.ts:116-121`):

1. Template T is Tuesdays; Tue 2 Sep is generated.
2. Wed 3 Sep — the teacher edits T to Thursdays. Existing classes stand (the
   20 Aug stamp rule). Candidates become Thu 4, 11, 18, 25 Sep.
3. Thu 4 Sep is declined: the week of Mon 1 Sep already holds Tue 2 Sep from T.
4. The teacher removes the past Tue 2 Sep class. **This spec allows it.**
5. Next hourly sweep: that week now holds nothing from T → **Thu 4 Sep is
   generated.**

**The rule does not change and the predicate does not narrow.** What changes is
the *justification*, and it is corrected here rather than left to go stale:

> Removal never resurrects the removed class. Under week-keyed generation it may
> free that class's *week*, which is the week rule working as specified.

Confined precisely to **past ∧ generated**. A manual class has
`templateId: null`, belongs to no template's week, and is unaffected in either
era. Today, pre-284, occupancy is per-date and the whole interaction is inert —
this is a constraint on 284, not a live defect, and §8.3 posts it there.

---

## 6. Design

### 6.1 `src/services/studio-class-deletion.ts` — new, framework-agnostic

Modelled on `src/services/room-deletion.ts`, which is this codebase's existing
statement that *"archiving and deleting ask different questions and must answer
them differently"*.

```ts
export type StudioClassDeletability =
  | { deletable: true }
  | { deletable: false; reason: 'regenerates' };

export function studioClassDeletability(
  sc: { templateId: string | null; date: Date; startTime: string },
  now: Date,
  timeZone: string,
): StudioClassDeletability;

export const STUDIO_CLASS_REGENERATES_MESSAGE: string;
export const STUDIO_CLASS_REGENERATES_CODE = 'STUDIO_CLASS_REGENERATES';
```

- **Structural input, not the Prisma model**, so the page can pass a `select`ed
  subset and the unit tests need no database.
- **No `@/lib/log` import.** The route logs. This keeps the module importable
  from the page without pino anywhere near a client boundary — the hazard
  `src/lib/tiers.ts` and `src/lib/class-fields.ts` exist to avoid.
- The header carries §3, §4.1 and §4.2 in full. §4.2 is the load-bearing half:
  it is the edit a future contributor will make.

### 6.2 `DELETE /api/studio-classes/[id]`

Added beside the existing `GET` (`:14`) and `PUT` (`:32`), using the same gate
order those two already use:

| Step | Response |
|---|---|
| `requireTeacher` | 401 / 403 `Teacher access required` |
| `findUnique` miss | 404 `Studio class not found` |
| `studioClass.teacherId !== session.teacherId` | 403 `Access denied` |
| `studioClassDeletability` refuses | 409 + `STUDIO_CLASS_REGENERATES`, with `log.info` |
| `prisma.studioClass.delete`, `P2025` | 404 |
| success | `respondOk({ deleted: true })` |

The success shape matches `src/app/api/rooms/[id]/route.ts:114`. The
message-plus-code refusal matches `room-deletion.ts:68,106`
(`ROOM_DELETE_BLOCKED_MESSAGE` / `ROOM_IN_USE_CODE`), which is what keeps this
route out of issue 197's "conflict responses show developer strings" bucket.

`session.defaultTimezone` is available directly — it rides on the teacher branch
of `SessionUser` (`src/lib/types.ts:32-35`) precisely for computations like
this one.

**There is no check-to-delete race to backstop here, and this is deliberate.**
Neither disjunct can flip `deletable → not deletable`: `templateId` is
write-once at creation, and a past class cannot become future. The archive's
`deleteMany` is keyed on a concrete `templateId`, so it never matches a manual
row, and it filters `cancelledAt: null` and `date: { gt: today }`, so it never
matches a past one. The only real race is a double-click, which the `P2025`
catch answers as 404. Copying `room-deletion.ts`'s FK backstop would guard
nothing — the service header says so, because that file is the obvious model.

### 6.3 The page and the button

`src/app/(teacher)/studio-class/[id]/page.tsx` computes deletability
server-side and passes a boolean to a new client
`src/components/studio-class/delete-studio-class-button.tsx`, rendered in two
places:

- on the **cancelled** branch (`:60-64`), which today is a dead end with no
  action at all;
- beside `CancelStudioClassButton` on the live branch.

Label: **"Remove this class"**, not "Delete" — one destructive word per page,
and "Cancel class" already sits beside it. The HTTP verb stays `DELETE`; the
noun differing from the verb is intentional and noted in the component.

Copy, matching the two-step confirm `CancelStudioClassButton` already uses:

- when the row is one reporting counts — and the condition is **reporting's own
  predicate, not the deletability one**: `cancelledAt === null` and
  `date <= endOfToday` (`reporting/page.tsx:36`), with the figure computed the
  way `:52` computes it, `hourlyRate × durationMinutes / 60`:
  `Remove this class? €45.00 will come off your reported earnings. This cannot be undone.`
- otherwise:
  `Remove this class? This cannot be undone.`

The two predicates are close but not the same, and using the deletability one
here would be wrong in both directions. A **future-dated manual** class is
removable and is *not* in reporting's window, so it must not claim to cost
anything; a class **dated today whose start has passed** is removable and *is*
in the window, so it must. The overlap is large enough that a single predicate
would pass most tests — which is why §7.4 pins both cases.

Naming the euros mirrors the archive door's honesty: `withdrawnCount`'s docblock
records that `remaining` is *"returned once, for the confirmation message shown
right after the click"* and deliberately not persisted.

**On the server-snapshot hazard.** The `deletable` prop is a server-render
snapshot, and this project has been bitten by gating a control on server state a
sweep can change. It is safe here in one direction only, and the asymmetry is
the reason: the time clause can flip only `false → true`, so a stale `false`
hides a button that a refresh restores, and a stale `true` is unreachable. The
server still refuses authoritatively; the prop only decides what is drawn.

### 6.4 Audit trail

The issue's acceptance asks for one. The answer is: **the confirm names what
goes, the route logs it, and nothing is persisted** — decided, not defaulted.

- The app has no audit-log concept anywhere. `DELETE /api/rooms/[id]`,
  `/api/invitations/[id]` and `/api/teacher-links/[teacherId]` persist no
  deletion record. Introducing the first one for the least consequential model
  in the app, on a 2GB VPS, is backwards.
- `withdrawnCount` is not a counter-example. It exists because an *archive*
  removes rows the teacher never sees, in bulk, from a different page. A single
  removal is one row they are looking at, having just been told what it costs.
- A `deletedAt` soft-delete column is actively wrong here: it would re-create
  the permanent tombstone that removal exists to clear, and would keep holding
  `(templateId, date)`.

`log.info({ teacherId, studioClassId, templateId, cancelled }, 'studio class removed')`
on success, and the matching refusal line, following `rooms/[id]`.

---

## 7. Testing

### 7.1 Unit — `src/services/studio-class-deletion.test.ts`

The full matrix, `templateId ∈ {null, set}` × `start ∈ {past, future}` ×
`cancelledAt ∈ {null, set}` = 8 cases, expecting the §2 table with cancellation
orthogonal.

Plus two timezone cases, **in both directions**, because a test run at a UTC
hour where local and UTC agree proves nothing. `prisma/seed.ts:622-625` records
that failure directly:

> Outside those hours the row looks correct either way, so a developer checking
> at 10:00 Pacific — or from Europe, where these bugs do not manifest at all —
> will see nothing wrong and should not conclude the seed is pointless.

| Zone | Class | `now` (UTC) | Expected | A UTC-naive predicate says |
|---|---|---|---|---|
| `Europe/Amsterdam` (+2) | today 09:00 | 08:00 | removable (started 07:00Z) | refused |
| `America/New_York` (−4) | today 09:00 | 12:00 | refused (starts 13:00Z) | removable |

Plus the §4.2 pins: an archived template does not change a future generated
class's verdict, and a paused one does not either.

### 7.2 Mutations — each guard broken, error recorded, restored, re-verified

Warm the touched routes before scoring: `next dev` recompiles lazily and the
first request can blow a timeout that reads exactly like an assertion failure.

| # | Mutation | Must fail |
|---|---|---|
| M1 | Compare `sc.date <= startOfLocalDay(now, tz)` instead of start instants | Amsterdam row of §7.1 |
| M2 | Drop the `templateId === null` disjunct | manual-future case |
| M3 | Drop the past disjunct | past-generated case |
| M4 | Let the predicate read `template.isArchived` and allow removal | §4.2 pin |
| M5 | Remove the route's `teacherId !== session.teacherId` check | cross-teacher integration case |
| M6 | Skip the predicate in the route and delete unconditionally | 409 integration case |

M5 is listed explicitly because ownership is gate 4, and gate-4 defects hide
precisely because gates 1-3 pass.

### 7.3 Integration — two files, because the house splits them

**`tests/integration/studio-api.test.ts`** (appended to the existing 1080 lines,
API only — it carries 56 `api/` references and no page fetch): 401 without a
session; 403 on another teacher's class; 404 on a missing id; 409 with
`STUDIO_CLASS_REGENERATES` on a future generated class; 200 on a future manual
class; 200 on a past generated class; and a reporting-total assertion — the
studio earnings figure drops by `hourlyRate × durationMinutes / 60` after a past
logged class is removed.

**`tests/integration/studio-class-page.test.ts`** — new, following the
`privacy-api.test.ts` / `privacy-page.test.ts` split, fetching `BASE_URL` with
`cookie()` and asserting on HTML the way `privacy-page.test.ts:111-120` does.
Four cases, and the last two are the §6.3 pair that a single shared predicate
would get wrong:

1. a future **generated** class renders no Remove action;
2. a **cancelled** past class renders one, where the page renders a dead end today;
3. a **future-dated manual** class renders a Remove action with **no** euro claim;
4. a class **dated today whose start has passed** renders one **with** the figure.

This file is also the first integration coverage `studio-class/[id]/page.tsx`
has ever had — see §8.3's row for issue 143.

### 7.4 Component

Both figures are computed server-side in the page and handed down as props —
`deletable: boolean` and `earningsAtRisk: number | null` — so the client
component holds no predicate of its own and neither predicate is duplicated
across the server/client boundary.

`delete-studio-class-button.test.tsx`: renders or not per `deletable`; names the
euros when `earningsAtRisk` is a number and omits the sentence when it is null;
a failed response surfaces its message rather than falling silent, matching
`cancel-studio-class-button.tsx`'s reasoning that a confirm step makes silence
worse rather than safer.

The page's two computations are pinned where they are computed, in §7.3's
integration cases: a **future-dated manual** class renders a Remove action with
no euro claim, and a class **dated today whose start has passed** renders one
with the figure `hourlyRate × durationMinutes / 60`. A single shared predicate
would pass the first three cases of §7.1 and fail exactly these two.

---

## 8. Documentation — the issue's actual deliverable

### 8.1 `CLAUDE.md`

Under the studio material: the §2 rule, stated so the next reader stops
re-asking, and the sentence that archiving is a template's end state by design.

### 8.2 `prisma/schema.prisma`

- **Correct `:488`.** Replace *"An already-cancelled one is an income record and
  survives"* with the true reason from §3 — it survives because it holds
  `(templateId, date)` and because a deliberately cancelled date must not be
  refilled on resume. `reporting/page.tsx:36` excludes it from income.
- Add a `cancelledAt` docblock on `StudioClass` stating cancel-versus-remove.

### 8.3 Issue updates — four extensions, no new issues

| Issue | Update |
|---|---|
| 274 | 279 settles removal only; 276 keeps editability. The 275/276/277 working set is now two files, not three — this branch takes `api/studio-classes/[id]/route.ts` and `studio-class/[id]/page.tsx` first, and never touches `updateStudioClassSchema`. |
| 284 | §5's worked path, as a constraint on its acceptance. |
| 275 | Removal is refused on future generated classes, so un-cancel is the only remedy left standing — "release the date" was already withdrawn in its own first comment. |
| 143 | `studio-class/[id]/page.tsx` — one of the three uncovered teacher detail pages — gets its first integration coverage here (§7.3's `studio-class-page.test.ts`, four cases). The issue narrows to the other two pages and stays open. |

**One in, zero out.**

---

## 9. What this spec does not do

- **Issue 275 is unaffected.** Its future generated cancelled class is exactly
  the cell this door refuses. This spec narrows its remedy space to one; it
  supplies no un-cancel action.
- **Issue 276 is unaffected.** Editability — which fields, and whether `date`
  may join two unique keys — is its own decision, and `updateStudioClassSchema`
  is untouched here.
- **Issue 277 is unaffected.** No `cancelledAt` value is written by this branch.
- **Issue 284 is unaffected as code.** §5 is a note on its acceptance, not a
  change to the generator.
- **The archive door is unchanged.** §1.5 corrects prose only. Whether the
  archive should stop sparing cancelled rows is a different question and is not
  asked here — tracker 274 records that lifecycle as complete.
- **No retention sweep.** §1.6's unbounded `/schedule/past` affects both class
  families and is not this issue's to fix.

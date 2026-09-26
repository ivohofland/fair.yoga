# Switching a private room to the already-shared one at the same address

Issue 259. Spun out of #73, whose spec is
`2026-08-18-room-sharing-one-way-door-design.md` (§8 filed this as a decision,
not as work).

**Decision (option B):** one atomic operation moves the teacher onto the shared
room. It links the shared room (or reuses the link they already have), moves
**every template** and **every upcoming class** (draft or open, not cancelled)
off the private link and onto that one, and archives the private link.
Completed and cancelled classes stay where they happened. A class in progress
counts with them as history, and while one is running the switch waits for it
(§2 rule 2).

---

## 1. What the issue said, and what measurement changed

Measured 2026-09-26 against `238f90e0`, in a worktree off `origin/main`.

These held:

| Claim | Evidence |
|---|---|
| The exact-match branch tells the teacher to link the shared room by hand | `share-room-button.tsx:123-127`: "…You don't need to share yours — you can add it from Settings › Rooms › Add room." |
| `ClassTemplate.teacherRoomId` and `Class.teacherRoomId` both point at the link | `schema.prisma` `ClassTemplate.teacherRoom`, `Class.teacherRoom`, each a composite FK `(teacherRoomId, roomArchived)` |
| At most one link per teacher per room | `schema.prisma:357` `@@unique([teacherId, roomId])` |
| A private room carries only its creator's link | #77. `POST /api/teacher-rooms` accepts rooms that are shared or the caller's own |

Five things the issue did not have right, or did not have at all.

### 1.1 #76 is settled: deletion stays blocked, and archiving is the retirement

Option B's cost, as the issue wrote it, was "an archived room they cannot delete
until #76 is settled". #76 is closed. The outcome is that any `Class` row blocks
a hard delete (`ON DELETE RESTRICT`, `room-deletion.ts`), and archiving is how a
room with history is retired (`room-archive.ts`). So under B the private link
ends up **archived**, which is the normal end state for any room with history,
not a leftover.

### 1.2 Moving a class changes no price

The issue's question 2 ("which `TeacherRoom` values survive?") reads as an
economic question. It is not one. `Class.roomCost`/`maxStudents` and
`ClassTemplate.roomCost`/`maxStudents` are copied onto each row when it is
created (`class-generator.ts:59-65`; `POST /api/classes`). Booking capacity
reads `Class.maxStudents` (`waitlist.ts:1062`), never the link. Reporting reads
`Class.roomCost` (`settings/reporting/page.tsx`). The link's `rentalRate` and
`capacityOverride` only set the defaults the teacher's forms start from.

So moving a class means rewriting `teacherRoomId` (and its mirror) and nothing
else. That is also why the move does not collide with `settingsLocked`: it
freezes `ECONOMIC_FIELDS` (`class-fields.ts:13-19`), and `teacherRoomId` is not
one of them (`class-lifecycle.ts:1098`).

### 1.3 "Terminal" is no longer a status set

The issue writes terminal as `completed`/`cancelled`. Since #327, cancellation
is `CalendarEntry.cancelledAt`, and a cancelled class keeps its status. A
`Class` cancellation cannot be undone (`entry_terminal_liveness_guard`,
`20260826140000_entry_guard_restorations`). The predicate this spec calls
**upcoming**, the classes that move, is therefore:

```
status IN ('draft', 'open')
AND calendarEntry.cancelledAt IS NULL
```

`in_progress` is left out by decision (spec gate, 2026-09-26): a class that has
started belongs with the classes that happened, not with the ones still to
come. The start sweep sets it at the start instant
(`class-transitions.ts`, `autoTransitionToInProgress`, open → in_progress).

The predicate differs from `BLOCKING_CLASS_STATUSES` (`room-archive.ts:61`,
open and in_progress) in both directions. It takes `draft`: a draft may legally
sit in an archived room, but leaving one there would leave the teacher's
unfinished work in a room they have retired. It leaves out `in_progress`, and
§2 rule 2 deals with the consequence.

### 1.4 "The failure mode is a 409 rather than a fork" is wrong

The issue treats `@@unique([teacherId, roomId])` as a harmless edge. It is the
**expected** case: today's copy tells the teacher to link the shared room by
hand, and a teacher who did that already holds a link on it. A switch that
always inserts a link would be refused for exactly the teachers who followed
the app's own advice. The operation has to **reuse** an existing link, and
un-archive it if it is archived.

### 1.5 This is the first write that moves a class between rooms

Nothing updates `Class.teacherRoomId` after creation. Several places depend on
that:

- The `Class` mirror docblock: "no path moves a class between rooms"
  (`schema.prisma:499-501`).
- `room-archive.ts:35-37`: "a class never changes rooms".
- #339's spec §1.2 ("There is no `Class` move door") and §4.2. `lock-order.md`
  (around :3020-3040) builds "`TeacherRoom → Class` has no live counterparty"
  on "an `UPDATE` on `Class` triggers no referential check at all unless it
  touches an FK column".

This operation is that `UPDATE`. §4 places it in the lock order so the argument
still holds. Each place that states the old fact is corrected (§7).

Templates already have a move path (`PUT /api/class-templates/[id]`,
`class-template-lifecycle.ts:932-936`). It writes `roomArchived` from the target
in the same statement, which is the pattern the class move copies.

---

## 2. The decision, in rules

1. **Templates: all of them move.** Active, paused and archived alike. A
   template is a stamp, not history. An archived template left on the private
   link would be a trap: un-archiving it leaves it paused
   (`rule-lifecycle.ts`, `archiveOrUnarchiveRule`), and resuming a template in
   an archived room is refused.
2. **Classes: upcoming ones move, the rest stay.** "Upcoming" is the §1.3
   predicate. A completed or cancelled class keeps the link it happened under.
   After the switch it sits in an archived room, which is legal: the CHECK only
   constrains open and in-progress classes that are not cancelled.

   **An in-progress class stays too, so the switch refuses while one exists.**
   `Class_live_needs_open_room` refuses an `in_progress`, uncancelled class in
   an archived room. With one on P, archiving P fails. The only way to finish
   the switch would be to leave P usable, and "exactly one usable room" is the
   issue's acceptance criterion. So the switch answers 409 `ROOM_IN_USE` (§3.2)
   and the teacher tries again once the class has finished. That is at most the
   class's duration plus `FINISH_GRACE_MINUTES` away. It reuses the code
   archiving P already answers for the same cause, because the switch's refusal
   is exactly an archive of P being blocked by live use.
3. **The shared link:**
   - **No link yet:** create one carrying the private link's `rentalRate`
     and `equipmentNotes`, with `capacityOverride = min(private.capacityOverride, shared.maxCapacity)`.
   - **Link exists:** keep its values as they are. The teacher set them on
     purpose, and more recently. If it is archived, un-archive it.
4. **The private link is archived.** The private `Room` row is untouched. It
   stays the teacher's, still private, and can be un-archived like any other
   room.
5. **Economic fields are never written.** No class or template changes its
   `roomCost`, `maxStudents` or anything else in `ECONOMIC_FIELDS`. A moved open
   class whose `maxStudents` exceeds the new link's capacity stays bookable to
   its own `maxStudents`, exactly as it does today when a teacher lowers a
   link's capacity. Nothing ties the two (§1.2).
6. **Same room only.** The server refuses unless the two rooms match on the
   identity `sameRoomIdentity` defines (`room-identity.ts:51-57`: `address`,
   `floor`, `roomName` after trim and lowercase, mirroring
   `Room_public_identity_unique`). Without this rule the operation would be a
   general "move all my classes to any shared room" tool, and that changes
   where students go. The rule guarantees the same physical room.

### 2.1 What students see change

Every reader shows a class's location through the live relation
(`cls.teacherRoom.room`) and `formatRoomLocation(roomName, venueName)`
(`format.ts:4-6`). There is no copy anywhere: not in emails, not in ICS (there
is none), not in reporting. `roomName` is part of the identity, so it is the
same up to case and whitespace. **`venueName` is not**, so the venue name
students see can change, for example from "Studio Zen" to "Zen Yoga Centre".
This is accepted: it is the same room, now named the way the shared record
names it. The confirmation names the shared room by its display name
(`roomName || venueName`), so the teacher sees the new name before confirming.

---

## 3. The API

### 3.1 Endpoint

`POST /api/teacher-rooms/[id]/switch`, body `{ roomId: string }`. `[id]` is the
**private link**, and `roomId` is the **shared Room**.

This follows the house convention, measured over `src/app/api/**/route.ts`. It
has two shapes:

- **A state toggle on one row is `PATCH ?state=`**, as in
  `PATCH /api/teacher-rooms/[id]?state=archived|unarchived`.
- **A one-shot action is `POST /api/<resource>/[id]/<verb>`**, as in
  `classes/[id]/cancel`, `classes/[id]/complete`, `classes/[id]/transition`,
  `rooms/[id]/publish`, `payments/[id]/paid|unpaid|not-charged|remind`,
  `invitations/[id]/resend|respond` and `notifications/[id]/read`.

The switch is not a toggle. It is a compound action, so it gets a verb
sub-route. The resource is the one the action writes: `publish` sits under
`rooms` because it writes the `Room`, and the switch writes the teacher's links
and never a `Room`, so it sits under `teacher-rooms`. The settings page's `[id]`
is already this link id (`settings/rooms/[id]/page.tsx:21-24`).

The route is a thin wrapper over a new service, `src/services/room-switch.ts`,
exporting
`switchToSharedRoom(db, { teacherId, teacherRoomId, sharedRoomId })`. It is
framework-agnostic and returns a discriminated result. The route follows the
`teacher-rooms/[id]` shape: `withErrorHandler`, `requireTeacher`, `parseBody`
with a new `switchRoomSchema` in `schemas.ts`.

### 3.2 Answers, in guard order

| # | Condition | Answer |
|---|---|---|
| 1 | not signed in as a teacher | `requireTeacher`'s answer |
| 2 | private link not found | 404 `NOT_FOUND` |
| 3 | link belongs to another teacher | 403, same shape as the other `teacher-rooms/[id]` handlers |
| 4 | the link's room is shared | 409 `NOW_SHARED` |
| 5 | `roomId` not found, or not shared | 404 `NOT_FOUND`. A private room is not something this caller may know exists. |
| 6 | the two rooms are not the same room (§2 rule 6) | 409 **`NOT_SAME_ROOM`** (new) |
| 7 | already switched: private link archived, no template or upcoming class on it, and an unarchived link on the shared room | 200 `respondUnchanged`, carrying the shared link |
| 8 | a class on the private link is `in_progress` and not cancelled (§2 rule 2) | 409 `ROOM_IN_USE` |
| 9 | lock timeout | the existing 503 path |
| — | otherwise | 200 applied: `{ teacherRoom, moved: { templates, classes }, reusedLink, capacityClamped: { from, to } \| null }` |

Row 4 reuses `NOW_SHARED` rather than adding a code. It already means "this room
is shared now". The only way to get there is the teacher sharing the room in
another tab, and in that case there is nothing to switch.

Row 8 cannot come before row 7. An already-archived P can hold no in-progress
class, because the CHECK forbids it, so the two never both apply.

Copy for row 8: "A class is running in this room right now. You can switch once
it has finished."

Row 7 sits after every refusal that makes the goal moot or invalid (rows 2-6)
and before the write. That follows *Error responses* in
`technical-architecture.md`. It is not an oracle: the subject is the caller's
own link, and the shared room's existence is already public.

`NOT_SAME_ROOM` is reachable without a crafted request: the teacher edits the
private room's address in one tab while the share panel is open in another. Copy:
"This room's address no longer matches the shared room. Check its details and
try again."

---

## 4. The transaction

One `$transaction`, `setLockTimeout` first. Steps in this order. The order is
forced by the constraints, and none of them is deferrable
(`20260827120000_template_room_archive_invariant`,
`20260905120000_class_room_archive_invariant`). Every statement must leave
every row valid on its own.

| Step | What | Lock |
|---|---|---|
| 1 | Lock every `ClassTemplate` with `teacherRoomId = P` | `FOR UPDATE`, ascending `id`. The same statement as `setTeacherRoomArchived`'s pre-lock (`room-archive.ts:231-234`). |
| 2 | Lock the private link P, then re-read it with its room. Re-run guards 2-7 against what was read. | `FOR UPDATE` on `TeacherRoom` P |
| 3 | Shared link S: insert if absent (`ON CONFLICT DO NOTHING`), then lock it. If it is archived, un-archive it. | `FOR UPDATE` on `TeacherRoom` S |
| 4 | Lock P's classes that are `draft`, `open` or `in_progress` with `entryLive` true (not cancelled). If any is `in_progress`, refuse with `ROOM_IN_USE` and roll back. | `lockClassRowsOrdered` (ascending `id`, `db-locks.ts:698`) |
| 5 | Move the locked ones (all `draft`/`open` once step 4 has refused `in_progress`): `teacherRoomId = S`, `roomArchived = false`, keyed on the locked id set alone | — |
| 6 | Move every template on P: `teacherRoomId = S`, `roomArchived = false` | already held (step 1) |
| 7 | Archive P: `isArchived = true` | already held (step 2) |

Why each position:

- **Templates before links (1 → 2).** This is the order archiving already uses
  (`ClassTemplate → TeacherRoom`, `lock-order.md` "The room mirror's foreign keys
  are wait edges (#272)"). The generator holds its template lock
  (`claimRuleForGeneration`, `entry-generation.ts:417-424`) while its `Class`
  insert takes `KEY SHARE` on the link. Locking the link first would close a
  cycle with it.
- **Links before classes (2, 3 → 4).** `lock-order.md` states
  `TeacherRoom → Class` "on every side". Holding S before step 5 means the
  foreign-key check that step takes (`KEY SHARE` on S) is already satisfied by
  our own lock. The new `UPDATE` therefore adds **no new wait edge**, so §1.5's
  counterparty argument still holds. It gets a new sentence in `lock-order.md`
  rather than a new cycle.
- **P before S.** The roles are fixed: P is always private, S is always shared,
  and nothing switches the other way. A double-submitted switch serialises on P
  at step 2. The known two-room opposite-order shape (`lock-order.md`
  :2814-2819) needs a transaction that takes S before P, and none does.
- **Step 4 filters on `Class.entryLive`, not on a join to `CalendarEntry`.**
  `lockClassRowsOrdered`'s `where` docblock (`db-locks.ts`, `ClassLockSource`)
  warns that a joined table's mutable column is evaluated against a pre-wait
  snapshot `EvalPlanQual` does not re-fetch. A class cancelled while step 4
  waits on its row would still read as uncancelled and enter the lock set.
  Step 5 keys its write on the locked ids alone, so the write set is a
  structural subset of the lock set, as that docblock recommends. The lock set
  therefore has to be exact, and a joined predicate would move the cancelled
  class.
  `entryLive` is the cancellation mirror on the `Class` row itself (#339), kept
  by `ON UPDATE CASCADE` from the entry. A cancellation therefore rewrites the
  very row step 4 locks, and the re-check sees it. The transaction writes no
  entry column, so its `VERDICT (#327)` is "classes only, no entries".
- **Un-archive S before moving (3 → 5).** A live row moved onto an archived link
  fails the CHECK (23514).
- **Move before archiving (5, 6 → 7).** Archiving P while a live row still
  points at it cascades `roomArchived = true` onto that row, which fails with
  23514.
- **The move writes the mirror itself.** `ON UPDATE CASCADE` fires when the
  parent changes, not when the child repoints. A child that writes
  `teacherRoomId = S` must write `roomArchived = S.isArchived` (false, after
  step 3) in the same statement, or it fails with 23503.

**Why not call `setTeacherRoomArchived`?** It takes a `PrismaClient` and opens
its own transaction (`room-archive.ts:125, :200`), so it cannot run inside this
one. Its blocker count is also redundant here: after steps 5-6 the CHECK
guarantees the archive either succeeds or fails with 23514. The service archives
with one `UPDATE` and treats a 23514 at step 7 as a defect (500). No path should
reach it.

### 4.1 Races, and where each one lands

| Concurrent writer | Outcome |
|---|---|
| Hourly generator on a P template | Commits before step 1: its class is live on P, and step 4 finds and moves it. Waits at step 1: after commit it re-reads the template (`entry-generation.ts:438`) and generates on S. |
| `PUT /api/class-templates/[id]` moving a template onto P | Waits on P's `KEY SHARE` behind step 2, then meets an archived P. A live template gets the route's existing 409 `ROOM_ARCHIVED` race mapping. |
| `POST /api/classes` in P | Its `FOR KEY SHARE` on P (`classes/route.ts:115-119`) either commits first (step 4 moves the class) or waits behind step 2 and then reads P archived. A draft created there is legal and stays. That is the teacher's own concurrent act, the same as creating a draft in any archived room. |
| Start sweep (`open → in_progress`) on a class in P | Serialises on the `Class` row at step 4 (the sweep holds `lockClassRow`). Sweep first: step 4 sees `in_progress` and refuses with `ROOM_IN_USE`. Switch first: the class is on S when the sweep starts it. Either way nothing is left half-moved. |
| `completeClass` / `updateClass` on a class in P | Serialises on the `Class` row at step 4. A class that completes first drops out of the predicate (`FOR UPDATE` re-evaluates the `WHERE` on the new row version) and stays on P. |
| `setTeacherRoomArchived` on P | Same order (templates → P). Whichever commits second sees the other's result. |
| `setTeacherRoomArchived` on S | Takes S's templates then S — the reverse of this transaction's order when it reuses an archived S (step 3 locks S before un-archiving cascades onto S's own templates). A cycle needs a narrow precondition. `setTeacherRoomArchived`'s `unchanged` early return reads `isArchived` before opening its transaction, so a concurrent call whose pre-read already sees S archived never reaches its pre-lock at all — it must have read S live. That is only possible if a second, distinct archive of S commits in the window between that pre-read and this transaction's own step 3, which is what sees S archived. And S must hold a paused or archived template for step 3's un-archive to cascade onto anything (legal under the CHECK, which forbids only a live one on an archived room). Given that window, it ends in `40P01` on one side, with nothing half-applied on either. **Accepted** — narrower than the general order this design otherwise proves, and named with its `Class`-side counterpart in `lock-order.md` ("Switching to a shared room (#259)"). Outside that window it never wants P or P's templates, so there is no cycle; after our commit it counts the moved classes and answers `ROOM_IN_USE`. |
| A teacher-wide multi-class locker (for example `withdrawWaitingEntriesForTeacher`) while S is being un-archived | Un-archiving S at step 3 cascades onto S's own `Class` rows before step 4 locks P's. That is two ascending runs, not one, so a locker taking the teacher's classes in one ascending run can in principle cross it. The shape is the same one `setTeacherRoomArchived(…, 'unarchived')` already has, and it exists only when the reused link is archived. Postgres resolves any cycle with `40P01` on one side, and nothing is half-applied. **Accepted**, and named in the `lock-order.md` section. |
| The teacher edits P's `Room` address | Not locked. No path in `src/` locks a `Room` row, and adding one is a new lock node. The identity check reads the committed row at step 2. An edit landing after that read is the teacher's own concurrent edit, and the move still lands on a room that matched when checked. **Accepted**, and named here. |

`lock-order.md` gets one new section stating the order in §4 and the
no-new-edge argument, with the statement shapes. Its race harness follows
`room-archive-lock-order.test.ts`.

---

## 5. The UI

`ShareRoomButton`'s exact-match branch (`share-room-button.tsx:121-129`) keeps
its heading and gains the action:

> **Already shared**
> {name} at {address} is already shared with all teachers. You can switch to
> it: your recurring classes and upcoming classes move there, and this room is
> archived. Past classes stay with this room.
> `[Switch to shared room]` `[Cancel]`

- The button gets a new prop, `teacherRoomId`, from the page, which already has it.
- Success (applied or unchanged) runs `router.push('/settings/rooms')`. That is
  the house convention for an action that takes the current room off the
  detail page: `ArchiveRoomButton` (`archive-room-button.tsx:26`),
  `UnlinkRoomButton` (`unlink-room-button.tsx:25`) and `AddRoomFlow`
  (`add-room-flow.tsx:119`) all land there. No settings page reads a notice
  from the URL, and this spec does not add the first one. The list is enough:
  `RoomList` shows each link's capacity and rate, so a clamped capacity or a
  reused link's rate is in front of the teacher on arrival, on the shared room's
  row, and the private room has gone to *Archived rooms*.
- `NOT_SAME_ROOM`, `NOW_SHARED` and `ROOM_IN_USE` show their message inline in
  the existing `role="alert"` slot. `NOT_SAME_ROOM` and `NOW_SHARED` also call
  `router.refresh()`, because the page's picture of the room is what went stale
  (`server-snapshot-props-go-stale`). `ROOM_IN_USE` does not: nothing on the
  page is stale, and the teacher just tries again later.
- The near-match (warn) branch is unchanged. A same-street room with a
  different floor or room name is a human judgement (#73 §3), and the switch
  refuses it on the server anyway.
- `RoomMatchList` stays read-only here. The exact match is one room, so the
  action lives on the panel, not on the row.

Copy follows the register in `technical-architecture.md` *Error responses*.

---

## 6. Evidence the design must produce (acceptance)

Each guard is **mutation-tested**: break it, record the exact failure, restore.

1. **History stays, upcoming moves.** One fixture holds, on P, a `draft`, an
   `open`, a `completed`, and a cancelled `open` class. After the switch,
   exactly the first two are on S and the last two are on P. This fails under A
   (which moves all four) and under C (which moves none). Mutation: drop
   `cancelledAt: null` from the predicate, and the cancelled class moves.
1a. **A running class refuses the switch.** Add an `in_progress` class to the
   same fixture: 409 `ROOM_IN_USE`, and every row is exactly where it was,
   P still unarchived and no S link created. Mutations: add `in_progress` to
   the moved set, and the class moves where it should have refused. Drop the
   refusal, and step 7 fails with a 23514 that surfaces as a 500. Both are
   recorded.
2. **Every template moves**: active, paused and archived. Mutation: filter the
   template move to live rules, and the archived one stays.
3. **Atomic.** A failure injected after step 5 leaves P unarchived, no S link
   created, and every class and template on P. One usable room, not two
   half-linked ones.
4. **Capacity.** P at 30, shared `maxCapacity` 24 → the new link has 24, and
   `capacityClamped` is `{ from: 30, to: 24 }`. P at 20 → 20, `null`.
5. **Reuse.** An existing S link keeps its rate and capacity. An archived one
   is un-archived, and `reusedLink: true`.
6. **Refusals** assert codes via `expectRefusal`: `NOW_SHARED`,
   `NOT_SAME_ROOM`, 404 for a private or missing `roomId`, and 403 for another
   teacher's link. **Unchanged** on a repeat via `expectUnchanged`.
7. **Economics untouched.** Every moved row's `roomCost` and `maxStudents` are
   byte-identical before and after.
8. **Race harness** (§4.1): a concurrent generator claim on a P template, both
   orders. The generated class ends on S in every interleaving.
9. **Copy.** The exact-match branch renders the switch action. The old "add it
   from Settings › Rooms › Add room" sentence is gone (component test).

---

## 7. Claims this branch invalidates, to correct in place

Each is corrected by replacing it, not annotating it:

- `schema.prisma` `Class` mirror docblock: "no path moves a class between rooms".
  One path does now, and it writes the mirror itself.
- `room-archive.ts:35-37`: "a class never changes rooms".
- `class-lifecycle.ts:1098`: the note on `teacherRoomId` as a column no edit
  touches. Still true of `updateClass`, but the wording must not claim more.
- `share-room-button.tsx:44-45`, `room-match-list.tsx:11-13`,
  `room-search.ts:17-20`: each says "#259, not built".
- `lock-order.md`, the `TeacherRoom → Class` counterparty section: restated
  with the new writer. Also its stale `archiveRoom` name (:2907), which should
  be `setTeacherRoomArchived`. Same file, found in passing.

Specs of closed issues (#73, #339) are records and are not edited.

The plan derives its sweep from the diff, per `solve-issue` §4. It greps for
"moves a class", "changes rooms", "#259" and "not built".

---

## 8. Scope

- **In:** the service, route, schema and error code, the share-panel action, the
  `lock-order.md` section, and the comment corrections in §7.
- **Out:**
  - A general "move a class to another room" editor. §2 rule 6 exists to keep
    this from becoming one.
  - Switching from the near-match branch.
  - Server-side validation of `capacityOverride` against `maxCapacity` on
    `POST`/`PUT /api/teacher-rooms`. Both are client-only today
    (`room-settings-step.tsx:64`), which is pre-existing. This operation clamps
    its own write, and nothing else changes.
  - `StudioClass`. It has no room.
- **No migration.** Every constraint this needs already exists.
  **#76, #77 and #339 are unaffected.**

## 9. Decided at the spec gate (2026-09-26)

1. **In-progress classes are history**, alongside completed and cancelled ones.
   They stay, so the switch refuses while one is running (§2 rule 2).
2. **Endpoint:** `POST /api/teacher-rooms/[id]/switch`, following the
   verb-sub-route convention (§3.1).
3. **Landing:** `/settings/rooms`, following the room buttons' convention (§5).

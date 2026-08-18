# Sharing a room is a deliberate act, not a default (#73)

**Date:** 2026-08-18
**Issue:** #73 — `PUT /api/rooms/[id] { isPublic: true }` is an irreversible one-way door
**Spun out:** #259 (switching to an already-shared room), #260 (case-variant duplicates)

---

## 1. The issue's premise, measured

#73 is right about the mechanism and wrong about the blast radius. The correction is the most useful thing in this spec, so it goes first.

| Claim in #73 | Verdict |
|---|---|
| `updateRoomSchema` accepts `isPublic` (`src/lib/schemas.ts:187`) | **True, reference drifted** — now `src/lib/schemas.ts:298`. `createRoomSchema` carries it too, at `:285`. |
| PUT and DELETE both check `isPublic` before `createdById` | **True** — `src/app/api/rooms/[id]/route.ts:78` (PUT), `:29` (DELETE) |
| The creator is permanently locked out of editing and deleting their own room | **True for the `Room` row**, with one softening below |
| *"It isn't reachable from the UI … so this is API-only today. That makes it lower urgency."* | **False, and it is the load-bearing claim.** See below. |
| *"nothing pins the transition into it"* | **Half false** — #196 added `tests/integration/rooms-api.test.ts:628`, which pins one flip. It is refused by a unique index, not by policy; an uncontested flip still succeeds, unpinned. |

### The claim that fails

The **flip** (private → public via `PUT`) is API-only: `edit-room-form.tsx` does not expose the field, and the room detail page does not even render an edit form for a public room (`src/app/(teacher)/settings/rooms/[id]/page.tsx:32`, `canEditRoom = !room.isPublic && room.createdById === session.teacherId`).

The **lock** is not API-only. It is the default outcome of the only room-creation flow in the app.

`src/components/settings/add-room-flow.tsx` ends its create step with a single checkbox — *"Make this room visible to other teachers"* — whose state is `useState(true)` at `:95`. **Pre-checked.** Three layers agree:

| Layer | Reference | Value |
|---|---|---|
| Create form | `add-room-flow.tsx:95` | `useState(true)` |
| API | `src/app/api/rooms/route.ts:58` | `body.isPublic ?? true` |
| Column | `prisma/schema.prisma`, `Room.isPublic` | `@default(true)` |

So a teacher who walks the normal flow and leaves the box alone creates a room that `PUT` refuses with `Public rooms cannot be edited` and `DELETE` refuses with `Public rooms cannot be deleted` — both before either route looks at `createdById`. **Typo the venue name during creation and it is permanent, for everyone, forever.**

That is a live bug under the roadmap's own triage: a teacher will hit it, on the default path, with no warning.

### The softening, stated so nobody over-claims

The creator is not stuck looking at the room. `ArchiveRoomButton` and `UnlinkRoomButton` act on their `TeacherRoom`, which is always theirs. What is frozen is the shared identity: `venueName`, `address`, `city`, `postcode`, `floor`, `roomName`, `maxCapacity`, `equipment`, `notes`.

### What publishing actually changes about editing

Not simply "you lose edit rights" — the editing surface changes shape, and the room detail page already handles both states:

- **While private:** `EditRoomForm` covers the room fields and mirrors `capacityOverride` and `equipmentNotes` from them (`src/components/settings/edit-room-form.tsx:104-112`, *"Sync capacity, notes, and rental rate to teacher-room"*).
- **Once shared:** `canEditRoom` flips false, the page swaps to `EditTeacherRoomForm`, and `capacityOverride` / `rentalRate` / `equipmentNotes` become **independently editable** while the room fields render as read-only text.

The honest sentence is *you give up the shared facts and gain per-teacher control of your own*. The copy in §3 says exactly that.

---

## 2. The decision

The read-only lock is **kept**. #52/#60 settled that public rooms are community property and that the creator may have left the platform; `tests/integration/rooms-api.test.ts:1-13` already records the guard ordering as deliberate. This branch does not touch the lock.

What changes is how a room gets into that state:

1. **Rooms are born private.** All three defaults flip.
2. **Sharing gets its own door** — `POST /api/rooms/[id]/publish` — and `updateRoomSchema` stops accepting `isPublic` entirely, so the flip can never ride along on a generic field update.
3. **That door searches first**, so a teacher does not contribute a room the commons already has.
4. **The create-time checkbox stays**, unticked, carrying the same explanation. It is already downstream of the same search — step 1 of `add-room-flow` *is* the postcode/street query of shared rooms, and you only reach the create form by searching and finding nothing. What it lacked was the explanation, not the check.

### Duplicate handling: two different notions

The search (`GET /api/rooms?postcode=&street=`, `src/app/api/rooms/route.ts:26-37`) is a **fuzzy neighbourhood** query — `contains` + `mode: 'insensitive'`, whitespace-stripped postcode, shared rooms only. The database rule is an **exact identity** (`prisma/migrations/20260811202634_teacher_slot_unique_indexes/migration.sql:33`):

```sql
CREATE UNIQUE INDEX "Room_public_identity_unique"
  ON "Room" ("address", "floor", "roomName") WHERE "isPublic" = true;
```

Three branches follow, and the middle one is why the search is worth building — it is the case a unique index can never catch:

| Search result | Behaviour |
|---|---|
| No matches | Confirm |
| Same street, different `floor`/`roomName` | **Warn, allow.** Whether it is the same physical room is a human judgement. |
| Exact `(address, floor, roomName)` match | **Refuse**, and remove the confirm button rather than disabling it |

---

## 3. Vocabulary and copy

### `isPublic` on the wire, "shared" in front of a teacher

`src/components/settings/profile-form.tsx:171` already uses **"Public page"** for the teacher's *student-facing* page. If rooms also said "public", one word would mean two audiences — and rooms are teacher-to-teacher only; students never see them.

- **Unchanged:** the `isPublic` column and wire field, and the index names. Renaming them is a migration plus #196's index identifiers, far outside this issue.
- **Changed:** every teacher-facing string says "shared", including the two API error messages that reach the UI.
- **Deliberate seam:** the route path stays `/publish`, on the wire side of the split. Its neighbours are `isPublic` and `Room_public_identity_unique`; naming it `/share` would move the seam into the middle of the server instead of leaving it at the UI boundary.

This is a chosen inconsistency. It is recorded here so it is not "fixed" in the wrong direction later.

### `PublicRoomNotice` — one copy block, both callers

> **Sharing a room is permanent.**
> Other teachers can find this room and use it for their own classes. Its venue, address, capacity and props can no longer be changed or deleted — by you or by anyone else.
>
> Your rate, your capacity and your notes stay private to you, and stay editable.

Cost first, reassurance second. No persuasion in either direction — this is a tool, not a campaign.

### Create step

```
☐  Share this room with other teachers
   [PublicRoomNotice]
```

### Room detail — the sharing action

Rendered only when `canEditRoom` (private, and you created it), following `DeleteRoomButton`'s two-step inline confirm rather than a modal.

**Step 1:** a plain text action — `Share with other teachers`

**Step 2:** searches `GET /api/rooms` using the room's own `postcode` and `address`, then branches:

**No matches** — `PublicRoomNotice` + `[Share room] [Cancel]`

**Neighbourhood matches**
> **Rooms already shared at this address**
> *(read-only `RoomMatchList` rows)*
> If one of these is the same room, there's no need to share yours.

\+ `PublicRoomNotice` + `[Share room] [Cancel]`

**Exact identity match** — no confirm button at all
> **Already shared**
> {room} at {address} is already shared with all teachers. You don't need to share yours — you can add it from Settings › Rooms › Add room.

\+ `[Cancel]`

The exact-match branch **hides** the confirm rather than disabling it. A disabled control invites the teacher to hunt for what would enable it; there is no such state, and removing it says so.

### The pre-check is allowed to be wrong

It reads the commons when the flow opens. Another teacher can share a colliding room a second later. The route's `409 DUPLICATE_ROOM` stays the authority, and the flow never gates on a server-rendered snapshot — that is a client-side fetch on open, not a page prop.

---

## 4. API surface

### New — `POST /api/rooms/[id]/publish`

Sequential guards in the style of its neighbour `DELETE` (three ordered guards), **not** the `Record<Reason, …>` pattern from `POST /api/classes/[id]/transition`. That pattern exists because a service returns a typed union; rooms have no service layer, and introducing one for a single route is scope this branch does not take.

| Condition | Status | Code |
|---|---|---|
| No such room | 404 | `NOT_FOUND` |
| Not the creator | 403 | `NOT_ROOM_CREATOR` |
| Already shared | 409 | `ALREADY_SHARED` |
| Identity taken by a shared room | 409 | `DUPLICATE_ROOM` |

**The guard order is deliberately the inverse of PUT's and DELETE's, and the route must say so in a comment.** PUT and DELETE ask `isPublic?` first: a public room is community property regardless of who asks. Publish asks `createdById?` first: only the creator can donate. Same two guards, opposite order, both correct — and "make it consistent with its neighbours" is exactly the plausible future edit that would break it.

No pre-check for the duplicate. `POST /api/rooms` already carries the reasoning verbatim at `src/app/api/rooms/route.ts:60-68` — *"a `findFirst` guard in front would only make the catch reachable under a race — and untestable except by one"* — and this route follows its neighbour. The two-shape `isUniqueConflictOn` catch moves here, because this is now the only write that can flip the bit.

### Changed

| Change | Consequence |
|---|---|
| `updateRoomSchema` drops `isPublic` (`schemas.ts:298`) | The schema is `.strict()`, so `PUT { isPublic: true }` becomes a **400** — rejected, not silently ignored |
| PUT's collision catch (`rooms/[id]/route.ts:113-116`) | `Room_public_identity_unique` is now unreachable from PUT; the catch drops to the private shape and the `parsed.data.isPublic === true` ternary at `:119` collapses to one message |
| `createRoomSchema.isPublic` → `.optional().default(false)` | Lets `rooms/route.ts:58`'s `?? true` be **deleted** rather than inverted — one layer fewer, not one more |
| `Room.isPublic` → `@default(false)` + migration | Defence in depth: a future script creating a `Room` without the field gets the reversible state |
| Both routes' error prose | `Public rooms cannot be…` → shared vocabulary |

**The column default is safe to flip.** All four `prisma.room.create` calls in `prisma/seed.ts` (`:321`, `:336`, `:351`, `:405`) set `isPublic` explicitly (`:331`, `:346`, `:361`, `:414`) — 4 creates, 4 explicit values — so no dev data changes shape.

---

## 5. Modules

`add-room-flow.tsx` is **441 lines**, second-largest in `src/components/settings/` after `template-form.tsx` (533), holding a three-step state machine with **22 pieces of state** (23 lines mention `useState`; one is the import) in one flat namespace.

Two changes, on one branch, as separate commits so the feature diff reads clean:

**A — extract what the sharing flow forces.** Each unit has a real second caller on day one, which is the test that keeps an abstraction honest.

**B — split the three steps.** `add-room-flow.tsx` becomes a thin step router.

```
src/lib/room-identity.ts            sameRoomIdentity, findIdentityMatch   (pure, import-free)
src/lib/room-search.ts              searchPublicRooms(postcode, street) + RoomResult
src/components/settings/
  public-room-notice.tsx            the copy block, zero props
  room-match-list.tsx               rows; clickable iff onSelect is given
  share-room-button.tsx             two-step confirm, beside archive/delete/unlink
  room-search-step.tsx    ⎫
  room-create-step.tsx    ⎬ B
  room-settings-step.tsx  ⎭
src/app/api/rooms/[id]/publish/route.ts
```

### `room-identity.ts`

Two functions, not three. A `roomIdentityKey` string helper was considered and dropped — nothing dedups by key, and `sameRoomIdentity` is three `===` comparisons.

```ts
export interface RoomIdentity { address: string; floor: string; roomName: string }
export function sameRoomIdentity(a: RoomIdentity, b: RoomIdentity): boolean
export function findIdentityMatch<T extends RoomIdentity>(
  candidates: readonly T[], room: RoomIdentity,
): T | undefined
```

**Import-free**, for the reason CLAUDE.md gives for `src/lib/tiers.ts` and `src/lib/class-fields.ts`: the sharing button is `'use client'`, and anything reaching `@/lib/log` transitively fails the build (and passes `npm run verify`, which is what makes it expensive).

**Byte-exact, mirroring the index — no case folding, no trimming.** Its docblock names `Room_public_identity_unique`, its migration file, and the two disagreement modes:

- Predicate **stricter** than the index refuses a write Postgres would have accepted. Invisible, unrecoverable, and it tells the teacher "already shared" about a room that is neither theirs nor the same.
- Predicate **looser** lets the write through to the 409, which is the backstop that already exists.

Only the second is recoverable, so the predicate copies the index and the neighbourhood list handles human judgement. The residual — case-variant duplicates — is **#260**, and a comment beside `sameRoomIdentity` points at it.

### `room-identity.ts` has one caller, and that is stated rather than dressed up

The publish route does not use it (it lets the index refuse, per its neighbour). Its only consumer is the client pre-check. It earns its own file not on reuse but because a rule that must track a database index should be named, unit-tested and greppable — otherwise the drift is invisible.

### State that stays lifted in B

`postcode`/`street` (the search step feeds the create form's address defaults), `selectedRoom` (create feeds settings), and `step`. The other 18 push down, and the split reconciles:

| Home | State | Count |
|---|---|---|
| Parent (router) | `postcode`, `street`, `selectedRoom`, `step` | 4 |
| `room-search-step` | `results`, `searching`, `searchError` | 3 |
| `room-create-step` | `venueName`, `roomName`, `floor`, `city`, `maxCapacity`, `equipmentChecks`, `notes`, `isPublic`, `createError`, `creating` | 10 |
| `room-settings-step` | `capacityOverride`, `rentalRate`, `equipmentNotes`, `settingsError`, `saving` | 5 |
| | | **22** |

---

## 6. Testing — every guard proved to bite

Each guard below gets the break-record-restore-reverify treatment, with the mutation named. The mutation must use a change the code under test could plausibly receive, not the one that is easiest to write.

| # | Guard | Mutation that must break it |
|---|---|---|
| 1 | `PUT {isPublic:true}` → 400, room still private | re-add `isPublic` to `updateRoomSchema` |
| 2 | publish: non-creator → 403 (**product decision**) | delete the creator check |
| 3 | publish: **guard order** | reorder to `isPublic`-first |
| 4 | publish: already shared → 409 | delete the check |
| 5 | publish: identity taken → 409 `DUPLICATE_ROOM` | narrow the catch to the private shape (falls through to 500) |
| 6 | `sameRoomIdentity` is byte-exact | add `.toLowerCase()` |
| 7 | predicate and index agree | as 6, round-tripped through Postgres |
| 8 | checkbox unticked **and body sends `false`** | `useState(false)` → `useState(true)` |
| 9 | `createRoomSchema` defaults `isPublic` false | drop `.default(false)` |
| 10 | column defaults false | create a row without the field, read it back |
| 11 | exact match **hides** the confirm button | render it regardless |

### The three that are easy to get wrong

**#6 is the guard most likely to ship useless.** The realistic regression is not a wrong boolean — it is someone adding `.toLowerCase()` or `.trim()` to make matching "more helpful". Every obvious unit test passes against that version; the easy mutation (always `true`/`false`) is caught by anything. So the test carries **case-variant and whitespace-variant pairs asserted `false`**, with a comment stating that this mirrors a byte-exact partial index and is deliberately not a UX opinion.

**#7 is stronger than #6 and cheap.** Publish two rooms the predicate calls different — `Prinsengracht 42` and `prinsengracht 42` — and assert Postgres accepts both. This detects drift in *either* direction, which no unit test on the function alone can do.

**#2 and #3 are different tests, and only one can detect a swap** — the doctrine `tests/integration/rooms-api.test.ts:1-13` already states for PUT and DELETE. A non-creator on a *private* room answers 403 under **both** orderings, so that case pins the product decision and is blind to the order. Only a non-creator on an **already-shared** room separates them: creator-first answers `NOT_ROOM_CREATOR`, `isPublic`-first answers `ALREADY_SHARED`.

### A fixture that would pass while proving nothing

The neighbourhood/exact distinction. A search fixture containing **only** an exact match passes equally against code that blocks on *any* result. The fixture must hold **both** — one same-street-different-floor room that must not block, and one exact match that must — or the test cannot tell the two behaviours apart.

### Two more notes

- **#8 asserts the request body, not the checkbox.** An unchecked box that still posts `isPublic: true` is the regression shape that matters; `not.toBeChecked()` alone sails past it.
- **#10 needs no mutation gymnastics.** An applied migration must never be edited, but proving a column default does not require reverting one — `prisma.room.create` without the field, read back, *is* the proof.
- **#9 and #10 mask each other, so neither may be tested through the other.** They are belt and braces: with the column defaulting false, dropping `.default(false)` from the schema changes nothing observable at the API — `body.isPublic` arrives `undefined`, Prisma applies the column default, and the room is private either way. So **#9 is a unit test on `createRoomSchema.parse({…})`** and **#10 is an integration test on `prisma.room.create`**. A single end-to-end test asserting "a create without the field yields a private room" passes with either layer removed, and would certify nothing.

  The Zod default is worth keeping despite that redundancy, but **not** because of the #136 type pins — those compare key *names* (`keyof`), and `keyof {isPublic?: boolean}` still contains `"isPublic"`, so `add-room-flow.tsx:58-59` is unaffected either way. The reason is that it keeps the policy stated at the API boundary: with it, `rooms/route.ts` carries no default at all and `body.isPublic` is always a boolean; without it, the route silently forwards `undefined` and the only place that says "a new room is private" is a Postgres column default.

### One entry in `EXPECTED` stays

`src/lib/schemas.test.ts` keeps `createRoomSchema: ['isPublic']` — the create form still legitimately sends it, and that entry's comment already reads *"whether a newly created room is **shared** is legitimately the creator's call."* Only the `updateRoomSchema` entry and its KNOWN GAP comment go.

---

## 7. Artifacts this branch falsifies

Measured by grep, not assumed. **Eight locations to change, three verified clean, one verified still true.**

| Location | Claim | Fate |
|---|---|---|
| `src/lib/schemas.test.ts:420-424` | *"KNOWN GAP … Blocked on #73's isPublic product decision"* | Entry **and** comment deleted. The guard reads `Object.keys(shape)`, so removing the field from the schema makes this existing test the regression test for the removal — no new test needed. |
| `tests/integration/rooms-api.test.ts:115` | *"Room.isPublic defaults to true"* | **Becomes false** |
| `tests/integration/rooms-api.test.ts:563-570` | *"`updateRoomSchema` still accepts `isPublic`"* | **Becomes false** |
| `src/app/api/rooms/[id]/route.ts:99-106` | *"this PUT can flip a private room to public"* | **Becomes false** — rewritten |
| `tests/integration/rooms-api.test.ts:1-13`, `:236`, `:240` | header and message pins | Extended for the new door, reworded for vocabulary |
| `tests/integration/rooms-api.test.ts:628` | *"refuses flipping a private room public onto a slot a public room already holds"* | **Re-pointed, not deleted.** It pins that the catch matches both index shapes; that property moves to the publish route, so the test moves with it. A new test pins PUT's 400. |
| `docs/backlog-roadmap.md:424`, `:1433`, `:1797`, `:3055` | #73 open / blocked | At close |
| Issue #73, PR body | | At close |
| `tests/integration/rooms-api.test.ts:244` | *"the isPublic flip is one-way"* | **Still true** — that fixture flips via raw Prisma (`:274`), which this branch does not touch |
| `docs/data-model.md`, `CLAUDE.md`, `docs/technical-architecture.md` | — | **Checked: none mentions `isPublic`.** No live-doc drift |

The last two rows are negatives, recorded rather than implied — #39 shipped a stale live doc precisely by not looking.

---

## 8. Out of scope

- **#259 — switching a private room to an already-shared one at the same address.** The exact-match branch tells the teacher to add the shared room by hand. Automating that means repointing `Class.teacherRoomId` and `ClassTemplate.teacherRoomId`, which needs a decision about terminal-class history and runs into #76. Filed as a decision with options, not as work.
- **#260 — case- and whitespace-variant duplicates.** Pre-existing from #196's chosen key. `sameRoomIdentity` inherits it by design (see §5); the neighbourhood search surfaces both variants to a human, which is the mitigation this branch relies on.
- **The read-only lock itself.** #52/#60's decision stands, untouched.
- **Renaming the `isPublic` column.** §3's seam is deliberate.

## 9. Acceptance

1. A room created through the UI with the checkbox untouched is **private**, and its creator can edit and delete it.
2. `PUT /api/rooms/[id]` with `isPublic` in the body answers **400**, and the room's `isPublic` is unchanged.
3. `POST /api/rooms/[id]/publish` shares a room for its creator, and refuses the four conditions in §4 with the stated status and code.
4. The sharing flow refuses on an exact identity match with no confirm button, and allows on a neighbourhood match.
5. `sameRoomIdentity` and `Room_public_identity_unique` are proved to agree through Postgres.
6. Every guard in §6 has a recorded mutation, its exact error text, and a restore.
7. Every row in §7 marked "becomes false" is corrected, each verdicted individually.
8. `npm run verify` is green, with the integration file count stated as arithmetic in the PR body.

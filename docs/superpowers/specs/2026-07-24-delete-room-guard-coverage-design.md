# Behavioural tests for `DELETE /api/rooms/[id]`

**Date:** 2026-07-24
**Status:** Approved (issue #74; scope agreed with Ivo — the full guard ladder,
not only the ordering pin)

## Problem

`DELETE /api/rooms/[id]` has **zero** coverage. Nothing in `tests/` touches it;
`rooms-api.test.ts` (added by PR #70) covers `PUT` only.

It carries four guards past the shared `requireTeacher`/404 pair, and every one
of them is unpinned:

| # | Guard | Response |
|---|---|---|
| 1 | `room.isPublic` | 403 `Public rooms cannot be deleted` |
| 2 | `room.createdById !== session.teacherId` | 403 `Only the room creator can delete this room` |
| 3 | any `TeacherRoom` has classes | 400 `Cannot delete a room that has classes` |
| 4 | — | 200 `{ deleted: true }`, after deleting the room's `TeacherRoom` rows and the `Room` |

Two things make this worth covering rather than leaving to the next person.

**Guards 1–2 encode a product decision, in an order that looks like a bug.**
`isPublic` is checked *before* `createdById`, so a public room is undeletable
**even by its creator**. That is deliberate — public rooms are community
property and the creator may have left the platform (#52); #60's admin surface
is what will eventually mediate changes. It is also exactly the shape of thing
someone "fixes" later: letting the creator delete their own room reads as an
obvious correction, and nothing today would fail.

**Guards 3–4 are the destructive half.** The route hard-deletes rows. `Class`
holds a **required** relation to `TeacherRoom` with no `onDelete` override, so
Prisma's default `Restrict` applies: without guard 3, the route's
`teacherRoom.deleteMany` would hit a foreign-key violation. The 400 is what
turns a database-level failure into an intelligible response — a load-bearing
guard, untested.

## Scope

Extend `tests/integration/rooms-api.test.ts` with a `DELETE /api/rooms/[id]`
describe block:

| Case | Expected |
|---|---|
| **Non-creator** deletes a **public** room | 403 `Public rooms cannot be deleted` |
| **Creator** deletes their own **public** room | 403 `Public rooms cannot be deleted` |
| **Non-creator** deletes a **private** room | 403 `Only the room creator can delete this room` |
| **Creator** deletes a private room that **has a class** | 400 `Cannot delete a room that has classes` |
| **Creator** deletes a private, class-free room | 200; the `Room` and its `TeacherRoom` row are both gone |

Every non-200 case asserts the room **still exists**, not just the status code.

### Which case pins the ordering

Only the **non-creator + public** case. Work the 2×2 through both orderings:

| Case | Current (`isPublic` first) | Swapped (`createdById` first) | Detects a swap? |
|---|---|---|---|
| creator + private | proceeds to guard 3 | proceeds to guard 3 | no |
| non-creator + private | `Only the room creator can delete this room` | same | no |
| creator + public | `Public rooms cannot be deleted` | same | **no** |
| **non-creator + public** | `Public rooms cannot be deleted` | `Only the room creator can delete this room` | **yes** |

The creator-held case cannot discriminate: a creator always *passes* the
ownership guard, so under either ordering it falls through to `isPublic` and
returns the same message. That case pins the **product decision**; only the
non-creator-on-a-public-room case pins the **ordering**.

This is the correction PR #70's review established for `PUT`, applied here from
the start. See that spec's `## Correction` section.

### No `401` / `404` cases

`requireTeacher` is the same code on ~40 routes and is tested once in
`src/lib/api-utils.test.ts` — see "What earns an HTTP guard test" in
`docs/technical-architecture.md`. The existing `PUT` block omits them for the
same reason; the DELETE block stays consistent.

## Fixtures

A successful DELETE destroys its room, so the `PUT` block's pattern — one
shared room mutated in declaration order — cannot stretch to cover this. Each
DELETE case gets its **own** room, created in `beforeAll`, so no case depends
on another having run first:

| Fixture | State | Serves |
|---|---|---|
| `deletePublicRoomId` | `isPublic: true`, created by the creator | both public cases (neither destroys it) |
| `deletePrivateRoomId` | `isPublic: false`, created by the creator | the non-creator 403 |
| `deleteWithClassRoomId` | `isPublic: false`, plus a `TeacherRoom` and one `Class` | the 400 |
| `deleteEmptyRoomId` | `isPublic: false`, plus a `TeacherRoom` with **no** classes | the 200 |

`deleteEmptyRoomId` carries a `TeacherRoom` deliberately: a bare room with no
`TeacherRoom` rows would make the cleanup assertion vacuous.

**What the cleanup assertion proves.** `TeacherRoom.room` is declared
`onDelete: Cascade`, so those rows would disappear with the room even if the
route's explicit `teacherRoom.deleteMany` were removed. The assertion therefore
pins the **observable outcome** — no orphan `TeacherRoom` rows survive a room
delete — not that particular line of the handler. Worth stating so nobody later
reads it as coverage of the explicit delete.

`afterAll` removes the class first, then the teacher-rooms, then the rooms via
`deleteMany({ where: { id: { in: [...] } } })` over the truthy ids — which
no-ops cleanly over the room the happy path already deleted, where a bare
`delete` would throw. Guarded as the rest of the suite is: an undefined Prisma
filter turns `deleteMany` into delete-all.

## Restructuring the file header

`rooms-api.test.ts` opens with a header describing "these four cases", the 2×2,
and "all four cases share one room and run in declaration order". Those claims
are true of the `PUT` block and false of the file once DELETE lands.

- A short **file-level** header: both blocks cover the public-room lock, one for
  edits and one for deletes.
- The existing 2×2 and swap-analysis note moves onto the **`PUT` describe**.
- A parallel swap note goes on the **`DELETE` describe**, naming its own
  messages.

No changes to any existing `PUT` test body — this is comment restructuring
only.

## Out of scope

- **`GET /api/rooms/[id]`** — its guard is a single combined condition
  (`!room.isPublic && room.createdById !== teacherId`), not an ordered pair, so
  there is no ordering to pin. It would earn a test as ordinary authorization
  coverage, which is a different argument from this one; not smuggled in here.
- **The `isPublic` one-way door** (#73) — a real product question about
  `PUT { isPublic: true }` permanently locking the creator out of both editing
  and deleting. Tests pin what the code does today; changing what it does is
  that issue's job.

## Verification

`tsc` + `eslint` clean; the integration project green. Tests only — no `src/`
changes.

# Room remove gate — issue 266

**Goal:** a teacher refused a room delete or unlink can always reach a room
that is gone from their list by following only what the page and messages
say. Option 4 of the issue, agreed 2026-09-29: the page offers Delete/Unlink
only when the door's own counts say it will succeed, says why when it won't,
and the archive refusal names the next step.

**No spec.** One page, one sentence helper, two comment corrections; one
agreed design.

## What the premise check measured (origin/main at `861e7c09`)

- `settings/rooms/[id]/page.tsx` renders **Delete room** only when
  `classCount === 0 && canEditRoom && isArchived`, and **Unlink room** only
  when `classCount === 0 && !canEditRoom`. `classCount` counts every class on
  this link, any status. The Delete gate dates from `c94a6219` (2026-04-10).
- So the issue's row 2 (an `open` class) is unreachable from the UI; the
  reachable refusals are all **template** blockers:
  - Delete: always on an archived room, so the blocker is a paused/archived
    template (`ClassTemplate_live_needs_open_room` forbids a live one), and
    "Archive it instead" advises a state the room is already in. Every
    UI-reachable delete refusal is this loop.
  - Unlink, room not archived, live template → archive refuses (issue row 4).
  - Unlink, room archived → same loop as Delete.
- Since #327 the archive door excludes cancelled classes
  (`calendarEntry: { cancelledAt: null }`), so cancelling clears a class
  blocker.
- A template blocker is **not** permanent: templates are never hard-deleted,
  but `PUT /api/class-templates/[id]` moves a paused or archived template to
  another room, and `TemplateForm` renders for archived templates. The
  comments in `api/rooms/[id]/route.ts` (DELETE) and `room-deletion.ts`
  (`ROOM_DELETE_BLOCKED_MESSAGE`) that call it permanent are wrong.

## Out of scope

- The 409 copy (`ROOM_DELETE_BLOCKED_MESSAGE`,
  `TEACHER_ROOM_UNLINK_BLOCKED_MESSAGE`) stays. After Task 2 it reaches a
  teacher only when something changes between render and click (or a direct
  API caller), where "Archive it instead" is right for an unarchived room.
- No change to either door's predicates. The page reuses the **delete**
  door's counters, so no new coupling with the archive door.

## Task 1 — the archive refusal names the next step

**Files:** `src/services/room-archive.ts` (`describeRoomBlockers`),
`src/services/room-archive.test.ts` (the `describeRoomBlockers` table),
`tests/integration/teacher-rooms-api.test.ts` (the one exact-message
assertion, currently `'1 unfinished class still uses this room.'`).

**Behaviour.** The existing subject sentence stays; a second sentence names
what clears each blocker, using the UI's verbs (**Cancel**, **Finish class**,
**Pause recurring class**, **Archive recurring class**):

| blockers | message |
|---|---|
| 1 class | `1 unfinished class still uses this room. Cancel or finish it first.` |
| 2 classes | `2 unfinished classes still use this room. Cancel or finish them first.` |
| 1 template | `1 recurring class still uses this room. Pause or archive it first.` |
| 3 templates | `3 recurring classes still use this room. Pause or archive them first.` |
| 2 classes + 1 template | `2 unfinished classes and 1 recurring class still use this room. Cancel or finish the classes, and pause or archive the recurring class, first.` |
| 1 class + 2 templates | `1 unfinished class and 2 recurring classes still use this room. Cancel or finish the class, and pause or archive the recurring classes, first.` |
| 0 + 0 | `This room is still in use.` (unchanged — no blocker, no remedy to name) |

"Finish" covers both the teacher's Finish action and the automatic completion
15 minutes after the end; `in_progress` classes cannot be cancelled but can
finish, `open` ones can do either.

**Steps.**
1. Update the test table to the rows above (add the 1 class + 2 templates
   row); run `pnpm exec vitest run src/services/room-archive.test.ts` — RED.
2. Implement; GREEN.
3. Update the integration assertion; run it against the worktree app.
4. **Mutation:** drop the remedy sentence from the templates-only branch →
   the 1- and 3-template rows go red. Record the failure text, restore,
   re-run green, `git status` clean.
5. `src/components/settings/archive-room-button.test.tsx` mocks the message
   as an opaque string; leave it — it tests rendering, not the copy.

## Task 2 — the page gates on the delete door's counts

**Files:** `src/app/(teacher)/settings/rooms/[id]/page.tsx`,
`src/app/(teacher)/settings/rooms/[id]/page.test.tsx`,
`src/services/room-deletion.ts` (docblock only),
`src/app/api/rooms/[id]/route.ts` (DELETE comment only).

**Behaviour.**
- Replace the `classCount` query with the door's own counter: private
  (`canEditRoom`) → `countRoomDeleteBlockers(prisma, room.id)` (room-wide,
  matching `DELETE /api/rooms/[id]`); shared → `countTeacherRoomDeleteBlockers(prisma, teacherRoom.id)`
  (matching `DELETE /api/teacher-rooms/[id]`). `inUse = classes > 0 || templates > 0`.
- Delete: `canEditRoom && isArchived && !inUse` → `DeleteRoomButton`;
  `canEditRoom && isArchived && inUse` → caption
  `This room is used by your classes, so it can't be deleted.`
- Unlink: `!canEditRoom && !inUse` → `UnlinkRoomButton`; `!canEditRoom && inUse`
  → caption `This room is used by your classes, so it can't be unlinked.`
- Caption is a `<p className="type-caption">` in the same section; no
  button, no link.
- A private, unarchived room shows neither (unchanged — archive comes first).
- Rewrite the KNOWN-OPEN comment at the top of the page to describe the new
  snapshot: the counts are the delete door's, taken at render; a class or
  template landing on the room after render leaves the button offered and the
  click meets the route's 409, which stays the authority.

**Tests** (`page.test.tsx`; the prisma mock gains `classTemplate.count`, and
both counts answer per test):
- private + archived + 0/0 → Delete offered, no caption.
- private + archived + 0 classes, 1 template → no Delete, delete caption. *(the
  loop this issue exists for)*
- private + archived + 1 class, 0 templates → no Delete, delete caption.
- shared + 0/0 → Unlink offered.
- shared + 1 template → no Unlink, unlink caption.
- private: counts are read room-wide (`where: { teacherRoom: { roomId: 'room-1' } }`);
  shared: by link (`where: { teacherRoomId: 'tr-1' }`).

**Mutations** (each: apply, record failure text, restore, re-run green):
1. Gate on `classes` only (drop `templates` from `inUse`) → the template cases
   go red.
2. Swap the two counters → the where-argument cases go red.
3. Drop `isArchived` from the Delete gate → a private unarchived case must go
   red; if none does, add one.

**Comment corrections** (replace, don't annotate; PR body carries the before):
- `room-deletion.ts`, `ROOM_DELETE_BLOCKED_MESSAGE` docblock: a template is
  never hard-deleted, but it can be moved to another room, so the blocker is
  clearable — not "as permanent as class history". Replace the "remedy is
  named unconditionally … Tracked separately" paragraph with what is true
  now: the detail page offers this door only when these counts are zero, so
  the refusal reaches a teacher only through a change between render and
  click.
- `api/rooms/[id]/route.ts` DELETE: same "equally permanent" claim; same
  correction.

**Sweep after:** `git grep -n -i -E "permanent|Tracked separately|classCount" -- src`
and `git grep -n -i -E "delete room|unlink" -- 'docs/*.md'`; give every hit a
verdict.

## Finish

`pnpm run verify` (worktree app via `worktree:up`), PR naming both touched
integration/unit files, `/pr-review-toolkit:review-pr`, rebase-merge, then
`gh issue view 266 --json state`.

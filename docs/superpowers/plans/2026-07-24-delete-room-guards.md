# DELETE /api/rooms/[id] Guard Coverage — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin all five behaviours of `DELETE /api/rooms/[id]` — the guard
ordering, the product decision behind it, the creator guard, the
`hasClasses` 400, and the destructive happy path (issue #74).

**Architecture:** Tests only. Extend the existing
`tests/integration/rooms-api.test.ts` with a `DELETE /api/rooms/[id]` describe
block and four dedicated room fixtures, then restructure the file header so its
claims stay true now that the file covers two routes.

**Tech Stack:** Vitest integration project against the app on
`localhost:3000`, Prisma fixtures.

## Global Constraints

- **Tests only — no `src/` changes in any commit.** Task 2 temporarily edits a
  handler to prove the tests have teeth and **must revert it before
  committing**; a `git status` check enforces this.
- Read `src/app/api/rooms/[id]/route.ts` to source exact status codes and error
  strings. Do not guess them.
- Use the shared helpers already imported by this file (`BASE_URL`, `cookie`,
  `uniqueSuffix`, `seedSession` from `./helpers`). Semantic fixtures stay local.
- `afterAll` cleans in FK order with a **truthiness guard** on anything assigned
  in `beforeAll` — an undefined Prisma filter turns `deleteMany` into
  delete-all.
- Every non-200 case asserts the **room still exists**, not just the status
  code.
- Assert the **distinct** error messages where branches share a status — the two
  403s mean different things.
- Do not modify any existing `PUT` test body. Task 1 touches comments only
  outside the new DELETE block.
- Dev server must be running on `localhost:3000`. Don't run
  `signup-api.test.ts` — its per-IP limiter 429s on repeated local runs.

---

### Task 1: The DELETE block, its fixtures, and the header restructure

**Files:**
- Modify: `tests/integration/rooms-api.test.ts`

**Interfaces:**
- Consumes: `BASE_URL`, `cookie`, `uniqueSuffix`, `seedSession` from
  `tests/integration/helpers.ts`; the file's existing `makeTeacher(tag)` helper
  and its `creatorToken` / `otherToken` module-level bindings.
- Produces: nothing consumed by later tasks except the test file itself.

Read `src/app/api/rooms/[id]/route.ts` first. The `DELETE` handler's guard order
is: `requireTeacher` → 404 `Room not found` → **`isPublic` → 403 `Public rooms
cannot be deleted`** → `createdById` → 403 `Only the room creator can delete
this room` → `hasClasses` → 400 `Cannot delete a room that has classes` →
deletes the room's `TeacherRoom` rows, then the `Room` → 200 `{ deleted: true }`.

Responses are wrapped: success is `{ data: ... }`, errors are
`{ error: { message } }`.

- [ ] **Step 1: Replace the file header**

The current header (lines 1–27) describes the PUT block's 2×2 and its shared
room. Those claims become false as a *file* header once DELETE lands. Replace
lines 1–27 with:

```ts
/**
 * /api/rooms/[id] — the public-room lock, on both mutating verbs.
 *
 * `isPublic` is checked BEFORE `createdById` in both PUT and DELETE, so a
 * public room is read-only AND undeletable for everyone — including its own
 * creator. Deliberate (#52/#60: public rooms are community property and the
 * creator may have left the platform; an admin surface will eventually mediate
 * changes), but surprising enough that a future reordering could look like a
 * bug fix while silently reversing that decision.
 *
 * Each describe block below carries its own note on which of its cases pins
 * the *ordering* versus which pins the *product decision* — they are not the
 * same case, and only one of them can detect a guard swap.
 */
```

- [ ] **Step 2: Move the 2×2 note onto the PUT describe**

The material deleted in Step 1 still belongs to PUT. Put it directly above
`describe('PUT /api/rooms/[id]', ...)`:

```ts
/**
 * These four cases cover the full 2x2 of {creator, non-creator} x {private,
 * public}, but they don't split evenly by what they prove:
 *   - creator+public pins the *product decision* — a public room is
 *     read-only even for its own creator (see #52/#60).
 *   - non-creator+public pins the *guard ordering*. It is the only
 *     combination whose message differs when the two guards are swapped:
 *     current order (isPublic first) says "Public rooms cannot be edited";
 *     swapped (createdById first) says "Only the room creator can update
 *     this room". The other three cases return the same message under either
 *     ordering — creator+private and non-creator+private never reach the
 *     isPublic guard's alternate message, and creator+public passes the
 *     createdById guard as a no-op either way it's ordered.
 *
 * All four cases share one room and run in declaration order — the isPublic
 * flip (third case) is one-way, so any case declared below it inherits a
 * public room.
 */
```

- [ ] **Step 3: Add the `del` request helper**

Directly below the existing `put` helper:

```ts
function del(token: string, id: string) {
  return fetch(`${BASE_URL}/api/rooms/${id}`, {
    method: 'DELETE',
    headers: cookie(token),
  });
}
```

- [ ] **Step 4: Add the new module-level fixture bindings**

Below the existing `let roomId: string;`:

```ts
// DELETE fixtures — one room per case. A successful delete destroys its room,
// so these cannot share one room the way the PUT cases do; dedicated rooms
// also mean no DELETE case depends on another having run first.
let deletePublicRoomId: string;
let deletePrivateRoomId: string;
let deleteWithClassRoomId: string;
let deleteEmptyRoomId: string;
let deleteClassId: string;
```

- [ ] **Step 5: Add a local `makeRoom` helper inside `beforeAll` and use it for all five rooms**

Replace the existing `const room = await prisma.room.create({ ... }); roomId = room.id;`
block in `beforeAll` with the helper plus all five creates. Declare `makeRoom`
inside `beforeAll` so it closes over `creator.id` — the same shape
`classes-api.test.ts` uses for its local `makeClass`:

```ts
  // Local fixture helper — the five rooms below share every field except
  // roomName and isPublic. Declared here so it closes over the creator's id
  // rather than reading it back off a module-level let.
  function makeRoom(roomName: string, isPublic: boolean) {
    return prisma.room.create({
      data: {
        venueName: 'Rooms API Studio',
        address: `${suffix} Rooms St`,
        city: 'Testville',
        postcode: '1234RA',
        floor: '1',
        roomName,
        maxCapacity: 10,
        createdById: creator.id,
        isPublic,
      },
    });
  }

  // Room.isPublic defaults to true (the `isPublic` field in prisma/schema.prisma)
  // — passed explicitly throughout, since these fixtures depend on the value.
  const room = await makeRoom('Main', false);
  roomId = room.id;

  // -- DELETE fixtures ----------------------------------------------------
  // Public: serves BOTH public DELETE cases — neither one destroys it.
  const deletePublicRoom = await makeRoom('Delete Public', true);
  deletePublicRoomId = deletePublicRoom.id;

  // Private, no teacher-rooms: the non-creator 403. Kept separate from the
  // happy-path room, which gets destroyed.
  const deletePrivateRoom = await makeRoom('Delete Private', false);
  deletePrivateRoomId = deletePrivateRoom.id;

  // Private, with a TeacherRoom that has a class: the hasClasses 400.
  const deleteWithClassRoom = await makeRoom('Delete With Class', false);
  deleteWithClassRoomId = deleteWithClassRoom.id;
  const withClassTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: creator.id, roomId: deleteWithClassRoomId, capacityOverride: 8, rentalRate: 15 },
  });
  const blockingClass = await prisma.class.create({
    data: {
      teacherId: creator.id,
      teacherRoomId: withClassTeacherRoom.id,
      classType: 'Rooms API Delete Guard',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'draft',
    },
  });
  deleteClassId = blockingClass.id;

  // Private, with a TeacherRoom but NO classes: the 200. The TeacherRoom is
  // deliberate — a room with none would make the cleanup assertion vacuous.
  const deleteEmptyRoom = await makeRoom('Delete Empty', false);
  deleteEmptyRoomId = deleteEmptyRoom.id;
  await prisma.teacherRoom.create({
    data: { teacherId: creator.id, roomId: deleteEmptyRoomId, capacityOverride: 8, rentalRate: 15 },
  });
```

Note `creator` is the existing `const creator = await makeTeacher('creator');`
binding. The module-level `creatorId` is already assigned by this point and
would work identically — `creator.id` is used purely for locality, so the
helper's dependency is visible where it is declared rather than resolved
through a module-level `let`.

- [ ] **Step 6: Extend `afterAll`**

Replace the existing single-room cleanup —

```ts
  if (roomId) {
    await prisma.room.delete({ where: { id: roomId } });
  }
```

— with FK-ordered cleanup across all five rooms. `Class.teacherRoom` is a
required relation with no `onDelete` override, so Prisma defaults it to
`Restrict`: the class must go before its teacher-room, and the teacher-rooms
before their rooms.

```ts
  // FK order: class -> teacher-rooms -> rooms. Class.teacherRoom is a required
  // relation defaulting to Restrict, so the class must go first or the
  // teacher-room delete throws.
  if (deleteClassId) {
    await prisma.class.deleteMany({ where: { id: deleteClassId } });
  }
  const roomIds = [
    roomId,
    deletePublicRoomId,
    deletePrivateRoomId,
    deleteWithClassRoomId,
    deleteEmptyRoomId,
  ].filter(Boolean);
  if (roomIds.length > 0) {
    await prisma.teacherRoom.deleteMany({ where: { roomId: { in: roomIds } } });
    // deleteMany, not delete: the happy-path case already removed one of these
    // rooms, and deleteMany no-ops over a missing row where delete would throw.
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  }
```

- [ ] **Step 7: Add the DELETE describe block**

At the end of the file, after the PUT describe:

```ts
/**
 * Same split as the PUT block, different messages:
 *   - creator+public pins the *product decision* — a public room can't be
 *     deleted even by its creator.
 *   - non-creator+public pins the *guard ordering*. Under the current order
 *     (isPublic first) it returns "Public rooms cannot be deleted"; swap the
 *     two guards and it returns "Only the room creator can delete this room".
 *     It is the only case whose result changes, because a creator passes the
 *     createdById guard as a no-op under either ordering.
 *
 * Unlike the PUT block, each case here owns its room — a successful delete
 * destroys one, so shared mutable state would make the cases order-dependent.
 */
describe('DELETE /api/rooms/[id]', () => {
  it('a non-creator is rejected from a public room — this is what actually pins the ordering', async () => {
    const res = await del(otherToken, deletePublicRoomId);
    expect(res.status).toBe(403);

    // The isPublic guard's message, NOT the createdById guard's. Swapping the
    // two guards in the handler flips this string — see the block comment.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Public rooms cannot be deleted');

    expect(await prisma.room.count({ where: { id: deletePublicRoomId } })).toBe(1);
  });

  it('the creator is rejected from their own public room — pins the product decision', async () => {
    const res = await del(creatorToken, deletePublicRoomId);
    expect(res.status).toBe(403);

    // This case can't detect a guard swap (the creator passes the createdById
    // guard either way). What it pins is that a public room is undeletable by
    // the person who created it — deliberate, see the file header.
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Public rooms cannot be deleted');

    expect(await prisma.room.count({ where: { id: deletePublicRoomId } })).toBe(1);
  });

  it('a non-creator is rejected from a private room — creator-only message', async () => {
    const res = await del(otherToken, deletePrivateRoomId);
    expect(res.status).toBe(403);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Only the room creator can delete this room');

    expect(await prisma.room.count({ where: { id: deletePrivateRoomId } })).toBe(1);
  });

  it('the creator cannot delete a room that still has classes -> 400, nothing removed', async () => {
    const res = await del(creatorToken, deleteWithClassRoomId);
    expect(res.status).toBe(400);

    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toContain('Cannot delete a room that has classes');

    // The teacher-room assertion matters as much as the room one: the handler
    // deletes teacher-rooms BEFORE the room, so a missing guard would leave
    // the teacher-room gone even though the room survived.
    expect(await prisma.room.count({ where: { id: deleteWithClassRoomId } })).toBe(1);
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteWithClassRoomId } })).toBe(1);
  });

  it('the creator deletes a private, class-free room -> 200, room and teacher-rooms gone', async () => {
    // Premise: the room really does carry a teacher-room, or the cleanup
    // assertion below would pass vacuously.
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteEmptyRoomId } })).toBe(1);

    const res = await del(creatorToken, deleteEmptyRoomId);
    expect(res.status).toBe(200);

    const json = (await res.json()) as { data: { deleted: boolean } };
    expect(json.data.deleted).toBe(true);

    // TeacherRoom.room is declared onDelete: Cascade, so these rows would go
    // with the room even without the handler's explicit deleteMany. This pins
    // the observable outcome — no orphan teacher-rooms survive a room delete —
    // not that specific line of the handler.
    expect(await prisma.room.count({ where: { id: deleteEmptyRoomId } })).toBe(0);
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteEmptyRoomId } })).toBe(0);
  });
});
```

- [ ] **Step 8: Run the file**

Run: `npx vitest run --project integration tests/integration/rooms-api.test.ts`
Expected: 9 passed (the 4 existing PUT cases + 5 new DELETE cases), 0 failed.

If the happy-path case fails on a leftover room from an aborted earlier run,
the fixtures are namespaced by `suffix` — a fresh run gets fresh rooms. Do not
add cleanup-on-startup logic.

- [ ] **Step 9: Confirm no PUT test body changed**

Run: `git diff -U0 tests/integration/rooms-api.test.ts | grep -E '^\+|^-' | grep -v '^\+\+\+\|^---'`

Read the output: every `-` line must be either part of the old file header or
the old single-room `beforeAll`/`afterAll` cleanup. No line from inside a
`describe('PUT ...')` `it` block may appear as removed or added.

- [ ] **Step 10: tsc + eslint**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0, no output.

- [ ] **Step 11: Commit**

```bash
git add tests/integration/rooms-api.test.ts
git commit -m "test: pin the DELETE /api/rooms/[id] guard ladder (#74)"
```

---

### Task 2: Prove the ordering test has teeth

**Files:**
- Temporarily modify (and revert — **never commit**):
  `src/app/api/rooms/[id]/route.ts`

**Interfaces:**
- Consumes: the DELETE describe block from Task 1.
- Produces: nothing — this task's deliverable is evidence, reported in full.

This is the failing-test step, adapted. The behaviour already existed before
the tests, so nothing can be watched failing in the usual way. But PR #70's
central defect was tests that *claimed* to pin guard ordering and passed under
either ordering. The only way to know these don't repeat that mistake is to
swap the guards and watch exactly one case fail.

- [ ] **Step 1: Swap the two guards in the DELETE handler**

In `src/app/api/rooms/[id]/route.ts`, inside `DELETE`, the guards currently
read:

```ts
  if (room.isPublic) {
    return respondError('Public rooms cannot be deleted', 403);
  }

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can delete this room', 403);
  }
```

Swap them so the ownership check runs first:

```ts
  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can delete this room', 403);
  }

  if (room.isPublic) {
    return respondError('Public rooms cannot be deleted', 403);
  }
```

- [ ] **Step 2: Run the file and read the failures carefully**

Run: `npx vitest run --project integration tests/integration/rooms-api.test.ts`

Expected: **exactly one DELETE failure** — `a non-creator is rejected from a
public room — this is what actually pins the ordering` — asserting on the
received string `Only the room creator can delete this room` where `Public
rooms cannot be deleted` was expected.

The other four DELETE cases must still pass. All four PUT cases must still pass
(this task edits only the `DELETE` handler).

**If more than one DELETE case fails**, a case is coupled to guard order when
it shouldn't be — report it, do not "fix" it by loosening the assertion.
**If zero fail**, the ordering is still unpinned and Task 1's central claim is
false — stop and report that loudly rather than proceeding.

- [ ] **Step 3: Revert the handler**

```bash
git checkout -- src/app/api/rooms/[id]/route.ts
```

- [ ] **Step 4: Prove the revert is clean**

Run: `git status --short src/`
Expected: **empty output**. If anything appears under `src/`, the revert did
not take — stop and report. This plan's global constraint is that no commit
touches `src/`.

- [ ] **Step 5: Re-run the full gate on the reverted tree**

```bash
npx tsc --noEmit && npx eslint src tests
npx vitest run --project integration
```

Expected: tsc and eslint exit 0. The integration project is green except that
`signup-api.test.ts` may 429 from the local per-IP signup limiter on repeated
runs — note it if it happens; it is environmental and unrelated to this branch.

- [ ] **Step 6: Report the mutation evidence**

There is nothing to commit in this task. In your report, quote:
- the exact failing test name from Step 2,
- the exact expected-vs-received strings vitest printed,
- the pass/fail counts before (Task 1 Step 8) and during the swap,
- the output of Step 4.

---

### Task 3: Push and open the PR

- [ ] **Step 1: Push**

```bash
git push -u origin test/delete-room-guards
```

- [ ] **Step 2: Open the PR** — closes #74:

```bash
gh pr create --title "test: pin the DELETE /api/rooms/[id] guard ladder (#74)" --body "$(cat <<'BODY'
Closes #74. Spec: `docs/superpowers/specs/2026-07-24-delete-room-guard-coverage-design.md`

## Summary
`DELETE /api/rooms/[id]` had **zero** coverage — nothing in `tests/` touched it. It carries four guards past the shared `requireTeacher`/404 pair, and all four were unpinned. This adds five cases covering the whole ladder.

- **The ordering** — `isPublic` is checked *before* `createdById`, so a public room is undeletable **even by its creator**. Deliberate (#52/#60: community property, and the creator may have left the platform), and exactly the shape of thing someone later "fixes" as an obvious bug. Now pinned.
- **The `hasClasses` 400** — load-bearing, not cosmetic. `Class.teacherRoom` is a required relation with no `onDelete` override, so Prisma defaults it to `Restrict`: without this guard the handler's `teacherRoom.deleteMany` hits a foreign-key violation. The 400 is what turns a database error into an intelligible response.
- **The happy path** — 200, and both the `Room` and its `TeacherRoom` rows are gone.

Tests only — no `src/` changes. Every non-200 case asserts the room still exists, not just the status code.

## Which case pins *ordering*

Same correction PR #70's review established, applied here from the start:

| Case | Current (`isPublic` first) | Swapped (`createdById` first) | Detects a swap? |
|---|---|---|---|
| creator + private | proceeds to the `hasClasses` guard | same | no |
| non-creator + private | `Only the room creator can delete this room` | same | no |
| creator + public | `Public rooms cannot be deleted` | same | **no** |
| **non-creator + public** | `Public rooms cannot be deleted` | `Only the room creator can delete this room` | **yes** |

A creator always *passes* the ownership guard, so a creator-held case falls through to `isPublic` under either ordering and cannot discriminate. Only the last row can.

**This was verified by mutation, not by argument:** the two guards were temporarily swapped in the handler and the suite re-run. Exactly one case failed — the non-creator-on-a-public-room case — with `Only the room creator can delete this room` where `Public rooms cannot be deleted` was expected. The handler was then reverted; no `src/` change is in this branch.

## Fixtures
A successful delete destroys its room, so the PUT block's one-shared-room pattern doesn't stretch here. Each DELETE case owns its room, so no case depends on another having run. The happy-path room deliberately carries a `TeacherRoom` — without one the cleanup assertion would pass vacuously.

Note `TeacherRoom.room` is `onDelete: Cascade`, so those rows would disappear with the room even without the handler's explicit `deleteMany`. The assertion pins the observable outcome — no orphan teacher-rooms survive — not that specific line. Said so in the test rather than letting it read as coverage it isn't.

## Not covered
`GET /api/rooms/[id]` — its guard is a single combined condition, not an ordered pair, so there is no ordering to pin. It would earn a test as ordinary authorization coverage, which is a different argument.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 3: Report the PR URL. Do NOT merge.**

---

## Self-Review

**Spec coverage:** the spec's five-case table → Task 1 Step 7; the ordering
analysis → Task 1's DELETE block comment plus Task 2's mutation proof; the
four-fixture table → Task 1 Step 5; the "what the cleanup assertion proves"
caveat → Task 1 Step 7's happy-path comment and the PR body; the header
restructure → Task 1 Steps 1–2; the `GET` and #73 out-of-scope notes → the PR
body's "Not covered". The `401`/`404` omission is carried by the Global
Constraints and the spec, and needs no task.

**Placeholder scan:** none. Every step carries the literal code or the exact
command with its expected output. The two conditional branches (Task 2 Step 2's
"more than one fails" / "zero fail") name both outcomes and require reporting
rather than improvising.

**Consistency:** fixture binding names (`deletePublicRoomId`,
`deletePrivateRoomId`, `deleteWithClassRoomId`, `deleteEmptyRoomId`,
`deleteClassId`) are identical across Steps 4, 5, 6 and 7. The `del(token, id)`
helper defined in Step 3 is used with that exact signature in all five cases.
`creator.id` and the module-level `creatorId` are interchangeable inside
`beforeAll` — Step 5 says which to use and why, so an implementer doesn't have
to guess that the choice is stylistic.

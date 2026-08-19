# Room-delete template guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both room-delete routes refuse with 409 when a `ClassTemplate` references the room, instead of 500-ing on a raw foreign-key violation — which also closes the deadlock vector against the generator sweep, because the deadlock needs that template row to exist.

**Architecture:** A framework-agnostic `src/services/room-deletion.ts` owns the blocker counts, the refusal string and the FK names, mirroring how `room-archive.ts` owns the archive door. Both routes become thin wrappers over it. A narrow `isRestrictViolationOn` matcher in `src/lib/api-errors.ts` backstops the check-to-delete race.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma 6, PostgreSQL, Vitest (three projects: `unit`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-08-19-room-delete-template-guard-design.md`

## Global Constraints

- **TypeScript `strict: true`** — no `any`, no implicit types. `noUncheckedIndexedAccess` is on: indexing an array yields `T | undefined`.
- **Refusal string, verbatim, for every blocker:** `Cannot delete a room with class history. Archive it instead.` — status **409**.
- **Blocker predicate for deletion is EVERY template** — no `isActive` / `isArchived` filter. Do **not** reuse `ACTIVE_TEMPLATE_WHERE`; see Task 2.
- **Services take typed inputs, return typed outputs, and import no `next/*`.**
- **Never edit an applied migration.** No migration is needed in this branch.
- **Never start or restart the dev server on :3000.** The user runs it; `integration` talks to it over HTTP.
- **Commit per task** — the PR is rebase-merged and the per-task history is the record.
- **Measured baseline (2026-08-19, `npx vitest run`):** 134 files, 1590 tests, all passing. Per project: 62 unit (`src/**/*.test.ts`) + 31 integration (`tests/integration/**/*.test.ts`) + 41 components (`src/**/*.test.tsx`) = 134. **Re-measure at the end; do not inherit this number.**

---

### Task 1: The `isRestrictViolationOn` matcher

Narrow matcher for `P2003`, keyed on the constraint name. Consumed by Tasks 3 and 4.

**Files:**
- Modify: `src/lib/api-errors.ts` — add after `isRecordNotFound` (ends `:247`)
- Test: `src/lib/api-errors.test.ts` — new `describe` at the end (file is 457 lines)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function isRestrictViolationOn(error: unknown, constraints: readonly string[]): boolean`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/api-errors.test.ts`. It already has a `prismaError(code, meta)` helper at `:10` — reuse it, do not write a second one. Add `isRestrictViolationOn` to the existing `import { ... } from './api-errors'` at `:4`.

```ts
describe('isRestrictViolationOn', () => {
  /**
   * The three shapes were MEASURED on 2026-08-19 by provoking each delete
   * against a TeacherRoom carrying one archived ClassTemplate and zero Class
   * rows, not hand-written:
   *
   *   teacherRoom.delete:     {"modelName":"TeacherRoom","constraint":"ClassTemplate_teacherRoomId_fkey"}
   *   teacherRoom.deleteMany: {"modelName":"TeacherRoom","constraint":"ClassTemplate_teacherRoomId_fkey"}
   *   room.delete:            {"modelName":"Room","constraint":"ClassTemplate_teacherRoomId_fkey"}
   *
   * `modelName` DIFFERS across them — `room.delete` trips the constraint
   * through the Room→TeacherRoom cascade — which is exactly why the matcher
   * keys on `constraint` alone. A matcher that also required
   * `modelName === 'TeacherRoom'` would pass every teacher-rooms test and
   * silently 500 the rooms route.
   *
   * [CORRECTED IN PR REVIEW — the last sentence was false. `DELETE
   * /api/rooms/[id]` issues `teacherRoom.deleteMany` first, so it reports
   * "TeacherRoom" like its sibling; the "Room" shape comes from a bare
   * `room.delete`. The decision stands as a forward-looking one. See the
   * shipped docblock in `src/lib/api-errors.ts`.]
   */
  const ROOM_FKS = ['ClassTemplate_teacherRoomId_fkey', 'Class_teacherRoomId_fkey'] as const;

  it('matches the template FK from either delete, despite the differing modelName', () => {
    for (const modelName of ['TeacherRoom', 'Room']) {
      const err = prismaError('P2003', {
        modelName,
        constraint: 'ClassTemplate_teacherRoomId_fkey',
      });
      expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(true);
    }
  });

  it('matches the class FK too — the Class guard has the same race and no other backstop', () => {
    const err = prismaError('P2003', {
      modelName: 'TeacherRoom',
      constraint: 'Class_teacherRoomId_fkey',
    });
    expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(true);
  });

  /**
   * The mutation guard, and the only case that fails when the matcher is
   * widened to "any P2003" — which is the tempting simplification, because
   * every case above passes under it.
   *
   * `Registration_classId_fkey` is a REAL constraint
   * (`20260403092044_init/migration.sql:354`), deliberately not an invented
   * name: an assertion against a string nothing in the schema produces cannot
   * distinguish a working matcher from one that matches nothing at all.
   */
  it('does not match a P2003 from an unrelated foreign key', () => {
    const err = prismaError('P2003', {
      modelName: 'Registration',
      constraint: 'Registration_classId_fkey',
    });
    expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(false);
  });

  it('does not match a non-P2003, a non-Prisma throwable, or a missing constraint', () => {
    expect(
      isRestrictViolationOn(
        prismaError('P2002', { constraint: 'ClassTemplate_teacherRoomId_fkey' }),
        ROOM_FKS,
      ),
    ).toBe(false);
    // The bare-substring trap `isTransientDbError` documents at :208 — an
    // Error whose text merely quotes the constraint name is not a P2003.
    expect(isRestrictViolationOn(new Error('ClassTemplate_teacherRoomId_fkey'), ROOM_FKS)).toBe(
      false,
    );
    expect(isRestrictViolationOn(undefined, ROOM_FKS)).toBe(false);
    expect(isRestrictViolationOn(prismaError('P2003', { modelName: 'TeacherRoom' }), ROOM_FKS)).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project unit src/lib/api-errors.test.ts
```

Expected: FAIL at import — `"isRestrictViolationOn" is not exported by "src/lib/api-errors.ts"`.

- [ ] **Step 3: Write minimal implementation**

Insert into `src/lib/api-errors.ts` immediately after `isRecordNotFound` (which ends at `:247`), before the `classifyApiError` docblock:

```ts
/**
 * True when Prisma refused a delete because a `RESTRICT` foreign key still
 * points at the row — `P2003` — and the constraint that refused is one of
 * `constraints`.
 *
 * Keyed on `meta.constraint`, never on `meta.modelName`. Measured: the same
 * `ClassTemplate_teacherRoomId_fkey` arrives as `modelName: "TeacherRoom"`
 * from `DELETE /api/teacher-rooms/[id]` and as `modelName: "Room"` from
 * `DELETE /api/rooms/[id]`, because the latter trips it through the
 * `Room`→`TeacherRoom` cascade. A matcher that also required the model would
 * pass one route's tests and 500 the other.
 *
 * [CORRECTED IN PR REVIEW: both routes emit "TeacherRoom" today — the rooms
 * route's `teacherRoom.deleteMany` refuses before `room.delete` is reached.
 * The "Room" shape is what that route acquires once the redundant statement
 * is removed, which is what keying on `constraint` protects.]
 *
 * NARROW BY CONSTRUCTION, and that is the whole design. A blanket
 * `P2003 → 409` in `classifyApiError` would be less code and worse: almost
 * everywhere else in this app a `P2003` means the server tried to write a
 * dangling reference, which is a defect that must stay a 500 at
 * `level: 'error'`. Relabelling those "still in use" would hide exactly the
 * class of failure this project hunts. `isUniqueConflictOn`
 * (`src/lib/unique-conflict.ts`) sets the same precedent one module over:
 * match the specific constraint, never the code class.
 *
 * Lives here rather than beside `isUniqueConflictOn` because this module
 * already claims the "what does this thrown value MEAN" lookup table — see
 * `isRecordNotFound`'s docblock, which argues against splitting that table by
 * who imports it.
 */
export function isRestrictViolationOn(error: unknown, constraints: readonly string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') {
    return false;
  }
  const constraint = error.meta?.constraint;
  return typeof constraint === 'string' && constraints.includes(constraint);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project unit src/lib/api-errors.test.ts
```

Expected: PASS, all cases green.

- [ ] **Step 5: Mutation — prove the narrowness bites**

Temporarily widen the matcher to accept any `P2003`:

```ts
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') {
    return false;
  }
  return true;   // MUTATION — restore after measuring
```

Run the same command. **Expected: exactly one failure**, `does not match a P2003 from an unrelated foreign key`, reading `expected true to be false`. Record the exact text in the commit message. Then restore the two real lines and re-run to confirm green.

If that case does **not** fail, the mutation was not applied — stop and re-check, do not proceed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-errors.ts src/lib/api-errors.test.ts
git commit -m "feat: a P2003 matcher that names its constraint, and a test that fails when it stops (issue 103)"
```

---

### Task 2: `src/services/room-deletion.ts`

The blocker counts, the refusal string, and the FK names — one module, framework-agnostic, mirroring `room-archive.ts`.

**Files:**
- Create: `src/services/room-deletion.ts`
- Create: `src/services/room-deletion.test.ts`

**Interfaces:**
- Consumes: `tests/room-fixtures.ts` → `fixtureRun(prefix)` returning `{ suffix, makeFixture, addClass, addTemplate, cleanup }`; `RoomFixture = { teacherId, roomId, linkId }`; `addTemplate(db, f, { isActive, isArchived })`.
- Produces:
  - `export const ROOM_DELETE_RESTRICT_FKS: readonly string[]`
  - `export const ROOM_DELETE_BLOCKED_MESSAGE: string`
  - `export type RoomDeleteBlockers = { classes: number; templates: number }`
  - `export async function countTeacherRoomDeleteBlockers(db: PrismaClient, teacherRoomId: string): Promise<RoomDeleteBlockers>`
  - `export async function countRoomDeleteBlockers(db: PrismaClient, roomId: string): Promise<RoomDeleteBlockers>`

- [ ] **Step 1: Write the failing test**

Create `src/services/room-deletion.test.ts`:

```ts
/**
 * The delete door's blockers (issue 103).
 *
 * Every case isolates ONE blocker and leaves the other at zero, for the reason
 * `room-archive.test.ts` states in its own header: a fixture that trips both
 * at once certifies neither, because either clause could be deleted outright
 * with the file green.
 *
 * The archived-template cases are the point of this file. The delete door's
 * predicate is EVERY template, and the obvious implementation — reusing
 * `ACTIVE_TEMPLATE_WHERE`, which the archive door two modules over uses — is
 * green against an active template and leaves the reproduced 500 exactly where
 * it was. See the mutation record at the foot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { fixtureRun } from '../../tests/room-fixtures';
import {
  countTeacherRoomDeleteBlockers,
  countRoomDeleteBlockers,
  ROOM_DELETE_RESTRICT_FKS,
  ROOM_DELETE_BLOCKED_MESSAGE,
} from './room-deletion';

const prisma = new PrismaClient();
// `rd-` distinguishes this file's rows from `room-archive.test.ts`'s (`ra-`)
// and `room-archive-doors.test.ts`'s, so each file's cleanup sweeps only its own.
const fx = fixtureRun('rd');

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

describe('countTeacherRoomDeleteBlockers', () => {
  it('counts nothing for a link with no classes and no templates', async () => {
    const f = await fx.makeFixture(prisma);
    expect(await countTeacherRoomDeleteBlockers(prisma, f.linkId)).toEqual({
      classes: 0,
      templates: 0,
    });
  });

  it('counts an ARCHIVED, INACTIVE template — the case that reproduced the 500', async () => {
    const f = await fx.makeFixture(prisma);
    await fx.addTemplate(prisma, f, { isActive: false, isArchived: true });
    expect(await countTeacherRoomDeleteBlockers(prisma, f.linkId)).toEqual({
      classes: 0,
      templates: 1,
    });
  });

  it('counts a PAUSED template — isActive false, not archived', async () => {
    const f = await fx.makeFixture(prisma);
    await fx.addTemplate(prisma, f, { isActive: false, isArchived: false });
    expect(await countTeacherRoomDeleteBlockers(prisma, f.linkId)).toEqual({
      classes: 0,
      templates: 1,
    });
  });

  it('counts a live template', async () => {
    const f = await fx.makeFixture(prisma);
    await fx.addTemplate(prisma, f, { isActive: true, isArchived: false });
    expect(await countTeacherRoomDeleteBlockers(prisma, f.linkId)).toEqual({
      classes: 0,
      templates: 1,
    });
  });

  it('counts a class of ANY status, including terminal ones', async () => {
    // Deliberately `completed`: the delete door is not the archive door.
    // `BLOCKING_CLASS_STATUSES` excludes terminal statuses because an archived
    // room may still hold history; a foreign key does not care, and a
    // completed class RESTRICTs the delete exactly as an open one does.
    const f = await fx.makeFixture(prisma);
    await fx.addClass(prisma, f, 'completed');
    expect(await countTeacherRoomDeleteBlockers(prisma, f.linkId)).toEqual({
      classes: 1,
      templates: 0,
    });
  });
});

describe('countRoomDeleteBlockers', () => {
  // Named for what it actually does. Reaching the template THROUGH the room —
  // `teacherRoom: { roomId }` rather than a link id — is the whole difference
  // from the function above. It does not prove the multi-link case: this
  // fixture makes one link per room, and a second link would need a second
  // teacher (`@@unique([teacherId, roomId])`). The route-level cross-teacher
  // case is already covered by `rooms-api.test.ts`'s
  // "another teacher's class blocks the creator's delete".
  it('reaches a template through the room, not only through the link', async () => {
    const f = await fx.makeFixture(prisma);
    await fx.addTemplate(prisma, f, { isActive: false, isArchived: true });
    expect(await countRoomDeleteBlockers(prisma, f.roomId)).toEqual({
      classes: 0,
      templates: 1,
    });
  });

  it('counts nothing for a room whose links are empty', async () => {
    const f = await fx.makeFixture(prisma);
    expect(await countRoomDeleteBlockers(prisma, f.roomId)).toEqual({ classes: 0, templates: 0 });
  });
});

describe('the shared constants', () => {
  // Pins the exact string both routes return. The `Class` guard already
  // shipped this wording; a template blocker reuses it deliberately (spec
  // §2.1), so a future edit that "improves" one door's copy has to face the
  // fact that it changes both.
  it('names one refusal for both blockers', () => {
    expect(ROOM_DELETE_BLOCKED_MESSAGE).toBe(
      'Cannot delete a room with class history. Archive it instead.',
    );
  });

  // Both FKs, because both RESTRICT a TeacherRoom delete
  // (`20260403092044_init/migration.sql:339,345`). Dropping either leaves that
  // half of the backstop matching nothing.
  it('lists both foreign keys that RESTRICT a TeacherRoom delete', () => {
    expect([...ROOM_DELETE_RESTRICT_FKS].sort()).toEqual([
      'ClassTemplate_teacherRoomId_fkey',
      'Class_teacherRoomId_fkey',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project unit src/services/room-deletion.test.ts
```

Expected: FAIL — `Failed to resolve import "./room-deletion"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/services/room-deletion.ts`:

```ts
import type { PrismaClient } from '@prisma/client';

/**
 * What blocks the HARD deletion of a room, and what to say when it does
 * (issue 103).
 *
 * The sibling of `room-archive.ts`, and deliberately not part of it: archiving
 * and deleting ask different questions and must answer them differently.
 *
 * ARCHIVING asks "would a template put classes here?" — only a live template
 * does, so that door uses `ACTIVE_TEMPLATE_WHERE`
 * (`src/lib/template-selection.ts`) and only `open`/`in_progress` classes.
 *
 * DELETING asks "does a row point here?" — and a foreign key reads neither
 * `isActive` nor `isArchived` nor `status`. Narrowing this module's predicates
 * to match the archive door's is the single most likely wrong edit here: it
 * compiles, it passes any test written against a live template, and it
 * restores the raw P2003 that issue 103 exists to remove. `room-deletion.test.ts`
 * carries archived and paused cases for exactly that reason.
 *
 * Framework-agnostic per CLAUDE.md: no HTTP, no `next/*`. Both routes are thin
 * wrappers.
 */

/**
 * Every foreign key that `RESTRICT`s a `TeacherRoom` delete
 * (`prisma/migrations/20260403092044_init/migration.sql:339,345`).
 *
 * Used with `isRestrictViolationOn` as the backstop for the check-to-delete
 * race. `Class_teacherRoomId_fkey` is here even though the `Class` guard
 * predates this issue: that guard has the identical race and had no backstop
 * at all.
 */
export const ROOM_DELETE_RESTRICT_FKS = [
  'ClassTemplate_teacherRoomId_fkey',
  'Class_teacherRoomId_fkey',
] as const;

/**
 * One refusal for both blockers, deliberately naming neither.
 *
 * A `ClassTemplate` is never hard-deleted anywhere in `src/` — there is no
 * `DELETE` verb on `/api/class-templates/[id]` — so a template blocker is as
 * permanent as class history and has the identical remedy. Wording that named
 * the cause would be right half the time and would imply, wrongly, that the
 * teacher can clear it. Same reasoning `classifyApiError` states for the two
 * terminality triggers ("any wording that names one column is wrong half the
 * time").
 */
export const ROOM_DELETE_BLOCKED_MESSAGE =
  'Cannot delete a room with class history. Archive it instead.';

export type RoomDeleteBlockers = { classes: number; templates: number };

/** Rows pointing at one teacher's link. */
export async function countTeacherRoomDeleteBlockers(
  db: PrismaClient,
  teacherRoomId: string,
): Promise<RoomDeleteBlockers> {
  const [classes, templates] = await Promise.all([
    db.class.count({ where: { teacherRoomId } }),
    db.classTemplate.count({ where: { teacherRoomId } }),
  ]);
  return { classes, templates };
}

/** Rows pointing at ANY link on one room — deleting the room takes them all. */
export async function countRoomDeleteBlockers(
  db: PrismaClient,
  roomId: string,
): Promise<RoomDeleteBlockers> {
  const [classes, templates] = await Promise.all([
    db.class.count({ where: { teacherRoom: { roomId } } }),
    db.classTemplate.count({ where: { teacherRoom: { roomId } } }),
  ]);
  return { classes, templates };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project unit src/services/room-deletion.test.ts
```

Expected: PASS, 9 cases.

- [ ] **Step 5: Mutation — prove the predicate choice bites**

This is the mutation that carries the design. Narrow both template counts to the archive door's predicate:

```ts
import { ACTIVE_TEMPLATE_WHERE } from '@/lib/template-selection';   // MUTATION
// ...
    db.classTemplate.count({ where: { teacherRoomId, ...ACTIVE_TEMPLATE_WHERE } }),   // MUTATION
    db.classTemplate.count({ where: { teacherRoom: { roomId }, ...ACTIVE_TEMPLATE_WHERE } }),   // MUTATION
```

Run the same command. **Expected: exactly three failures** — the archived-template case, the paused-template case, and `countRoomDeleteBlockers`'s archived case — each reading `expected { classes: 0, templates: 0 } to deeply equal { classes: 0, templates: 1 }`. The live-template case must stay **green**, which is the point: it is the case that cannot detect this edit.

Record the exact text. Restore and re-run to confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/services/room-deletion.ts src/services/room-deletion.test.ts
git commit -m "feat: the delete door's blockers, counted on a predicate a foreign key would recognise (issue 103)"
```

---

### Task 3: Wire `DELETE /api/teacher-rooms/[id]`

**Files:**
- Modify: `src/app/api/teacher-rooms/[id]/route.ts:123-147` (the `DELETE` handler)
- Test: `tests/integration/teacher-rooms-api.test.ts` — fixtures in `beforeAll`, cases in the `DELETE` describe at `:471`

**Interfaces:**
- Consumes: `isRestrictViolationOn` (Task 1); `countTeacherRoomDeleteBlockers`, `ROOM_DELETE_RESTRICT_FKS`, `ROOM_DELETE_BLOCKED_MESSAGE` (Task 2).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing test**

Add two module-level fixture ids beside the existing ones (near `:41`):

```ts
/** A link whose only reference is an ARCHIVED template — the 500 reproducer. */
let linkWithArchivedTemplateId: string;
/** A link whose only reference is a LIVE template. */
let linkWithLiveTemplateId: string;
```

In `beforeAll`, after the existing link fixtures are created, add (the helper `makeRoom` is defined in that block; give each link its own room because `@@unique([teacherId, roomId])` forbids two links on one pair):

```ts
  const archivedTemplateRoom = await makeRoom('Archived Template');
  const archivedTemplateLink = await prisma.teacherRoom.create({
    data: { teacherId: owner.id, roomId: archivedTemplateRoom.id, capacityOverride: 8, rentalRate: 15 },
  });
  linkWithArchivedTemplateId = archivedTemplateLink.id;
  await prisma.classTemplate.create({
    data: {
      teacherId: owner.id,
      teacherRoomId: archivedTemplateLink.id,
      classType: 'Teacher Rooms Delete Guard',
      dayOfWeek: 2,
      startTime: '18:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      isActive: false,
      isArchived: true,
    },
  });

  const liveTemplateRoom = await makeRoom('Live Template');
  const liveTemplateLink = await prisma.teacherRoom.create({
    data: { teacherId: owner.id, roomId: liveTemplateRoom.id, capacityOverride: 8, rentalRate: 15 },
  });
  linkWithLiveTemplateId = liveTemplateLink.id;
  await prisma.classTemplate.create({
    data: {
      teacherId: owner.id,
      teacherRoomId: liveTemplateLink.id,
      classType: 'Teacher Rooms Delete Guard Live',
      dayOfWeek: 3,
      startTime: '19:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      isActive: true,
      isArchived: false,
    },
  });
```

Add to the `DELETE` describe at `:471`:

```ts
  it('refuses a link referenced only by an ARCHIVED template -> 409, not a 500', async () => {
    // The exact state that reproduced `500 {"error":{"message":"Internal
    // server error"}}` before this branch: zero Class rows, one archived
    // ClassTemplate. Both delete routes did it; `rooms-api.test.ts` covers the
    // other. The status assertion is the whole test — 409 vs 500 is the bug.
    expect(await prisma.class.count({ where: { teacherRoomId: linkWithArchivedTemplateId } })).toBe(0);

    const res = await send('DELETE', ownerToken, linkWithArchivedTemplateId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Cannot delete a room with class history. Archive it instead.');

    // Nothing removed. The template is what RESTRICTs the delete, and a
    // teacher cannot delete it either — there is no DELETE verb on
    // /api/class-templates/[id] — so this room is permanently undeletable,
    // which is why the message points at archiving rather than at clearing.
    expect(await prisma.teacherRoom.count({ where: { id: linkWithArchivedTemplateId } })).toBe(1);
    expect(await prisma.classTemplate.count({ where: { teacherRoomId: linkWithArchivedTemplateId } })).toBe(1);
  });

  it('refuses a link referenced only by a LIVE template', async () => {
    const res = await send('DELETE', ownerToken, linkWithLiveTemplateId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Cannot delete a room with class history. Archive it instead.');
    expect(await prisma.teacherRoom.count({ where: { id: linkWithLiveTemplateId } })).toBe(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project integration tests/integration/teacher-rooms-api.test.ts
```

Expected: FAIL, both new cases, `expected 500 to be 409`.

- [ ] **Step 3: Write minimal implementation**

Replace the guard-and-delete tail of the `DELETE` handler (currently `:138-144`) with:

```ts
  // Both blockers in one read. `Class` was already guarded; `ClassTemplate`
  // was not, and a room referenced only by a template answered a raw P2003 as
  // a 500 (issue 103).
  const blockers = await countTeacherRoomDeleteBlockers(prisma, id);
  if (blockers.classes > 0 || blockers.templates > 0) {
    log.info(
      { teacherRoomId: id, teacherId: session.teacherId, blockers },
      'room delete refused: the room is still in use',
    );
    return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, 'ROOM_IN_USE');
  }

  // THE CHECK ABOVE IS NOT REDUNDANT WITH THE CATCH BELOW, AND REMOVING IT
  // REOPENS A DEADLOCK — with every test in this repo still green.
  //
  // `DELETE FROM "TeacherRoom"` locks the row, then the RESTRICT triggers take
  // `FOR KEY SHARE` on referencing `ClassTemplate` rows. The generator sweep
  // holds `FOR UPDATE` on a template (`claimTemplateForGeneration`) while its
  // `Class` insert needs `FOR KEY SHARE` on this `TeacherRoom` — a genuine
  // AB-BA cycle, `40P01`. The catch runs AFTER the DELETE has taken its locks,
  // so it cannot prevent the cycle; only never issuing the statement can, and
  // that is what this check does. `docs/lock-order.md` carries the full edge.
  try {
    await prisma.teacherRoom.delete({ where: { id } });
  } catch (err) {
    // The check-to-delete race: a template created in the gap. Same answer as
    // the check, rather than the 500 a bare P2003 falls through to.
    if (isRestrictViolationOn(err, ROOM_DELETE_RESTRICT_FKS)) {
      return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, 'ROOM_IN_USE');
    }
    throw err;
  }
```

Add the imports at the top of the file:

```ts
import { log } from '@/lib/log';
import { isRestrictViolationOn } from '@/lib/api-errors';
import {
  countTeacherRoomDeleteBlockers,
  ROOM_DELETE_RESTRICT_FKS,
  ROOM_DELETE_BLOCKED_MESSAGE,
} from '@/services/room-deletion';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project integration tests/integration/teacher-rooms-api.test.ts
```

Expected: PASS — the two new cases plus the two pre-existing DELETE cases, which must be untouched.

- [ ] **Step 5: Mutation — prove the guard bites**

Drop the template half of the refusal:

```ts
  if (blockers.classes > 0) {   // MUTATION — was: || blockers.templates > 0
```

Run the same command. **Expected: both new cases fail with `expected 500 to be 409`** — the raw P2003 resurfacing, which is the original bug. `refuses to delete a link that still carries class history` must stay green, proving the class half is independently pinned. Record the text, restore, re-run.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/teacher-rooms/[id]/route.ts" tests/integration/teacher-rooms-api.test.ts
git commit -m "fix: the teacher-room delete door refuses a template blocker instead of 500ing (issue 103)"
```

---

### Task 4: Wire `DELETE /api/rooms/[id]`, and make it one transaction

**Files:**
- Modify: `src/app/api/rooms/[id]/route.ts:15-53` (the `DELETE` handler)
- Test: `tests/integration/rooms-api.test.ts` — fixtures in `beforeAll` (near `:143`), cases in the `DELETE` describe at `:410`

**Interfaces:**
- Consumes: `isRestrictViolationOn` (Task 1); `countRoomDeleteBlockers`, `ROOM_DELETE_RESTRICT_FKS`, `ROOM_DELETE_BLOCKED_MESSAGE` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Add a fixture id beside the existing `delete*` ones (near `:46`):

```ts
/** Private, one link, referenced only by an archived template — the 500 reproducer. */
let deleteWithTemplateRoomId: string;
```

In `beforeAll`, after the `deleteWithClassRoom` block (ends `:148`):

```ts
  // Private, with a TeacherRoom whose only reference is an ARCHIVED template:
  // the blocker that used to answer 500. `makeRoom` is defined above.
  const deleteWithTemplateRoom = await makeRoom('Delete With Template', false);
  deleteWithTemplateRoomId = deleteWithTemplateRoom.id;
  const withTemplateTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: creator.id, roomId: deleteWithTemplateRoomId, capacityOverride: 8, rentalRate: 15 },
  });
  await prisma.classTemplate.create({
    data: {
      teacherId: creator.id,
      teacherRoomId: withTemplateTeacherRoom.id,
      classType: 'Rooms API Delete Template Guard',
      dayOfWeek: 4,
      startTime: '20:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      isActive: false,
      isArchived: true,
    },
  });
```

Add to the `DELETE` describe:

```ts
  it('the creator cannot delete a room referenced only by a template -> 409, not a 500', async () => {
    // Zero classes, one archived template. This reproduced
    // `500 {"error":{"message":"Internal server error"}}` before this branch —
    // and `delete-room-button.tsx` renders that message verbatim, so the
    // teacher read those words.
    expect(
      await prisma.class.count({ where: { teacherRoom: { roomId: deleteWithTemplateRoomId } } }),
    ).toBe(0);

    const res = await del(creatorToken, deleteWithTemplateRoomId);
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toBe('Cannot delete a room with class history. Archive it instead.');

    // Nothing removed — including the teacher-room, whose rentalRate CLAUDE.md
    // calls "never shared between teachers".
    expect(await prisma.room.count({ where: { id: deleteWithTemplateRoomId } })).toBe(1);
    expect(await prisma.teacherRoom.count({ where: { roomId: deleteWithTemplateRoomId } })).toBe(1);
  });
```

**Also correct a comment this change falsifies.** The existing case `the creator cannot delete a room that still has classes` carries, wrapped across `:458-459`:

> `Drop the guard and this is a 500 (withErrorHandler maps only P2002 to a status of its own), which the assertion above catches first.`

That stops being true the moment Task 4 lands the P2003 backstop. Replace that sentence with:

```ts
    // Drop the guard and this is still a 409 — the P2003 backstop added for
    // issue 103 catches the raw foreign-key violation and answers with the
    // same message. What the guard buys is not the status but the LOCKS: the
    // backstop only runs once the DELETE has already taken them. See the
    // block comment in the handler.
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project integration tests/integration/rooms-api.test.ts
```

Expected: FAIL, the new case, `expected 500 to be 409`.

- [ ] **Step 3: Write minimal implementation**

Replace `:23-50` of the handler. The `teacherRooms` include goes away — `countRoomDeleteBlockers` answers the same question and also counts templates:

```ts
  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) return respondError('Room not found', 404);

  if (room.isPublic) {
    return respondError('Shared rooms cannot be deleted', 403);
  }

  if (room.createdById !== session.teacherId) {
    return respondError('Only the room creator can delete this room', 403);
  }

  // Across every link on the room, since the delete takes them all. The 400
  // this replaced implied a clearable condition and named no way out; a room
  // with class history is permanently undeletable BY DESIGN — archiving is the
  // end state (issue 76). A template blocker is equally permanent, because a
  // ClassTemplate is never hard-deleted (issue 103), which is why one message
  // serves both. 409, a conflict with current state rather than a malformed
  // request.
  const blockers = await countRoomDeleteBlockers(prisma, id);
  if (blockers.classes > 0 || blockers.templates > 0) {
    log.info(
      { roomId: id, teacherId: session.teacherId, blockers },
      'room delete refused: the room is still in use',
    );
    return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, 'ROOM_IN_USE');
  }

  // ONE TRANSACTION, not two statements. Un-transacted, a failure between them
  // leaves the teacher's TeacherRoom rows — and the private rentalRate
  // CLAUDE.md says is "never shared between teachers" — deleted with the room
  // still standing.
  //
  // THE CHECK ABOVE IS NOT REDUNDANT WITH THE CATCH BELOW, AND REMOVING IT
  // REOPENS A DEADLOCK. The RESTRICT triggers take `FOR KEY SHARE` on
  // referencing ClassTemplate rows, which cycles against the generator sweep's
  // `FOR UPDATE` on a template plus its `Class` insert's `FOR KEY SHARE` on
  // this room's links. The catch runs after those locks are taken; only not
  // issuing the DELETE avoids the cycle. `docs/lock-order.md` carries the edge.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.teacherRoom.deleteMany({ where: { roomId: id } });
      await tx.room.delete({ where: { id } });
    });
  } catch (err) {
    // The check-to-delete race: a template created in the gap.
    if (isRestrictViolationOn(err, ROOM_DELETE_RESTRICT_FKS)) {
      return respondError(ROOM_DELETE_BLOCKED_MESSAGE, 409, 'ROOM_IN_USE');
    }
    throw err;
  }

  return respondOk({ deleted: true });
```

Add imports at the top:

```ts
import { log } from '@/lib/log';
import { isRestrictViolationOn } from '@/lib/api-errors';
import {
  countRoomDeleteBlockers,
  ROOM_DELETE_RESTRICT_FKS,
  ROOM_DELETE_BLOCKED_MESSAGE,
} from '@/services/room-deletion';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project integration tests/integration/rooms-api.test.ts
```

Expected: PASS, including the pre-existing cross-teacher and happy-path deletes.

- [ ] **Step 5: Mutation — prove the guard bites**

Drop the template half:

```ts
  if (blockers.classes > 0) {   // MUTATION — was: || blockers.templates > 0
```

**Expected: the new case fails.** Note what its status will be and record it honestly: with the backstop in place it may well answer 409 anyway, in which case the mutation is caught by nothing here — say so, and note that the guard's real job is the lock ordering, which no test in this suite can observe. If it fails with `expected 500 to be 409`, record that instead. Restore and re-run either way.

Then run the **second** mutation, which the backstop cannot mask — remove the `try`/`catch` entirely while keeping the guard dropped, and confirm the case fails with `expected 500 to be 409`. This is what proves the backstop is load-bearing rather than decorative. Restore both.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/rooms/[id]/route.ts" tests/integration/rooms-api.test.ts
git commit -m "fix: the room delete door refuses a template blocker, in one transaction (issue 103)"
```

---

### Task 5: Record the lock edge

**Files:**
- Modify: `docs/lock-order.md` (985 lines; `grep -n "TeacherRoom"` currently returns nothing)

**Interfaces:**
- Consumes: the handler comments from Tasks 3 and 4.
- Produces: nothing.

- [ ] **Step 1: Add the section**

Insert a new `##` section before `## Known conformance` (`:632`), matching the style of `### The slot key is a wait edge` (`:369`):

```markdown
## The RESTRICT trigger is a wait edge, and a route guard is what closes it (#103)

`ClassTemplate_teacherRoomId_fkey` and `Class_teacherRoomId_fkey` are both
`ON DELETE RESTRICT` (`20260403092044_init/migration.sql:339,345`). A
`DELETE FROM "TeacherRoom"` therefore locks the parent row and then runs the
triggers' `SELECT 1 FROM "ClassTemplate" WHERE "teacherRoomId" = $1 FOR KEY
SHARE` — a lock nothing in this document's site enumeration can see, because
no source line issues it.

The cycle:

| | holds | waits for |
|---|---|---|
| generator sweep | `ClassTemplate` `FOR UPDATE` (`claimTemplateForGeneration`) | `TeacherRoom` `FOR KEY SHARE`, from its `Class` insert's FK check |
| room delete | `TeacherRoom`, exclusively | `ClassTemplate` `FOR KEY SHARE`, from the RESTRICT trigger |

AB-BA, so `40P01`. It did not exist before #95, which is when the sweep first
held a template lock across its inserts.

**What closes it is a guard in each delete route, not a lock.** Both routes
count `ClassTemplate` rows and refuse with 409 before issuing the `DELETE`
(`countRoomDeleteBlockers`, `src/services/room-deletion.ts`), and the cycle
requires a template row to exist — that row is what gives the trigger something
to lock. With the guard in place the statement is never issued in the
deadlocking case.

**The `isRestrictViolationOn` catch beside each guard does NOT substitute for
it.** The catch runs after the `DELETE` has taken its locks; it converts the
outcome, it does not avoid the wait. Anyone removing the pre-check as
belt-and-braces reopens this edge with every test green, which is why both
handlers carry the warning inline.

**Residual, and accepted:** a template created between the check and the
`DELETE`. Bounded by the sweep's own `{ timeout: 10_000 }`
(`class-generator.ts:408`), and either outcome is already legible — `40P01` is
in `TRANSIENT_SQLSTATES` (`api-errors.ts:174`) and answers 503 retryable. A
`lock_timeout` on the delete was considered and rejected: it would add a
lock-taking node to the ordering `template-lock-order.test.ts` defends, for a
few seconds in a window that needs a concurrent template creation — the same
trade `room-archive.ts:146-147` refused.
```

- [ ] **Step 2: Verify the citations resolve**

```bash
grep -n "TRANSIENT_SQLSTATES" src/lib/api-errors.ts          # expect :174
grep -n "timeout: 10_000" src/services/class-generator.ts     # expect :408
grep -n "ON DELETE RESTRICT" prisma/migrations/20260403092044_init/migration.sql | grep teacherRoomId   # expect :339 and :345
```

Fix any that have drifted and say so in the commit message.

- [ ] **Step 3: Commit**

```bash
git add docs/lock-order.md
git commit -m "docs: the RESTRICT trigger is a wait edge, and the guard that closes it (issue 103)"
```

---

### Task 6: Whole-branch verification

- [ ] **Step 1: Run the full suite**

```bash
npm run verify
```

Needs the app live on :3000 (the user runs it — do not start or restart it). Expected: typecheck clean, lint clean, all three vitest projects green.

- [ ] **Step 2: Record the measured after-figure**

From the run's own output, note files and tests. Baseline was **134 files / 1590 tests**. Predicted after: 135 files (`room-deletion.test.ts`) and roughly 1590 + 9 (Task 2) + 4 (Task 1, one `describe` of four cases) + 3 (Tasks 3–4) ≈ 1606. **Do not report the prediction — report what the run printed.** #212's handover predicted 1294 and measured 1296.

- [ ] **Step 3: Reconcile the sweep**

List the files this branch changed and confirm each was intended:

```bash
git diff --name-only main...HEAD
```

Expected exactly: `docs/superpowers/specs/2026-08-19-room-delete-template-guard-design.md`, `docs/superpowers/plans/2026-08-19-room-delete-template-guard.md`, `docs/lock-order.md`, `src/lib/api-errors.ts`, `src/lib/api-errors.test.ts`, `src/services/room-deletion.ts`, `src/services/room-deletion.test.ts`, `src/app/api/rooms/[id]/route.ts`, `src/app/api/teacher-rooms/[id]/route.ts`, `tests/integration/rooms-api.test.ts`, `tests/integration/teacher-rooms-api.test.ts`.

- [ ] **Step 4: Sweep for claims this branch falsified**

```bash
grep -rn "Drop the guard" src/ tests/ docs/
grep -rn "is a 500" src/ tests/ docs/
```

Note the phrasing: the target sentence WRAPS mid-clause in the source
(`rooms-api.test.ts:458` ends `...withErrorHandler maps only` and `:459` begins
`P2002 to a status...`), so the obvious `grep "maps only P2002"` matches
nothing and reports a clean sweep over a stale claim. Grep a fragment that
cannot straddle the wrap.

Any hit outside the one corrected in Task 4 is a stale claim — correct it. `withErrorHandler` still special-cases P2002 *in `classifyApiError`*, but the two delete routes now answer P2003 themselves, so prose saying "a P2003 here is a 500" is false on this surface.

---

## Notes for the reviewer

**One addition beyond the spec, flagged deliberately:** the `log.info` on each refusal (Tasks 3 and 4). The spec did not call for it. It is included because the archive door one module over logs its refusal for a stated reason — `respondError` does not log and `withErrorHandler` logs only on `throw`, so an un-logged 409 leaves no record that a teacher hit a permanently-undeletable room. Strike it if you disagree; nothing else depends on it.

**Task order is load-bearing.** Tasks 3 and 4 both import from Tasks 1 and 2. Task 5's citations reference symbols Task 2 creates.

**What this branch does not do:** no migration, no `lock_timeout` on either delete, no change to the archive door's `ACTIVE_TEMPLATE_WHERE` predicate, and no `DELETE` verb for templates. **#104 is unaffected** and **#229 is unaffected**.

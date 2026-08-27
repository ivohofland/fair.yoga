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
 * it was. See the mutation recorded in commit `70baade`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun } from '../../tests/room-fixtures';
import {
  countTeacherRoomDeleteBlockers,
  countRoomDeleteBlockers,
  isRoomDeleteBlocked,
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
      'This room is still in use and cannot be deleted. Archive it instead.',
    );
  });

  // Both FKs, because both RESTRICT a TeacherRoom delete
  // (`20260403092044_init/migration.sql:339,345`). Dropping either leaves that
  // half of the backstop matching nothing.
  it('lists both foreign keys that RESTRICT a TeacherRoom delete', () => {
    expect([...ROOM_DELETE_RESTRICT_FKS].sort()).toEqual([
      'ClassTemplate_teacherRoomId_roomArchived_fkey',
      'Class_teacherRoomId_fkey',
    ]);
  });
});

/**
 * The FK names, checked against what Postgres and Prisma actually report.
 *
 * The cases above and `api-errors.test.ts`'s all build their P2003 by hand
 * (`prismaError('P2003', {...})`), so between them they pin the MATCHER and
 * the LIST but never the claim joining the two: that a refused delete really
 * arrives as `code: 'P2003'` with the constraint name in `meta.constraint`.
 *
 * Nothing else in the suite closes that gap. Both routes' integration cases
 * are stopped by the pre-check and never reach the `isRoomDeleteBlocked`
 * catch, so a Prisma upgrade that moved the name — to `meta.field_name`, or
 * into a nested `target` — would disarm both backstops with every test in the
 * repo still green. The shape was verified live once, by the mutation recorded
 * in 2798c5a, but that proof left with the mutation.
 *
 * These cases provoke the real errors instead of constructing them, which also
 * pins the reason the matcher keys on `constraint` alone: the SAME constraint
 * arrives under two different `modelName`s.
 */
describe('the FK names, against a real refused delete', () => {
  /** Returns what the delete threw, and fails loudly if it did not throw. */
  async function refusalFrom(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (err) {
      return err;
    }
    throw new Error('expected the delete to be refused by a RESTRICT foreign key, but it succeeded');
  }

  it('a teacherRoom delete blocked by a template reports ClassTemplate_teacherRoomId_roomArchived_fkey', async () => {
    const f = await fx.makeFixture(prisma);
    await fx.addTemplate(prisma, f, { isActive: false, isArchived: true });

    const err = await refusalFrom(() => prisma.teacherRoom.delete({ where: { id: f.linkId } }));

    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const known = err as Prisma.PrismaClientKnownRequestError;
    expect(known.code).toBe('P2003');
    expect(known.meta?.constraint).toBe('ClassTemplate_teacherRoomId_roomArchived_fkey');
    expect(isRoomDeleteBlocked(err)).toBe(true);
  });

  it('a BARE room delete reports the same constraint under modelName "Room"', async () => {
    // The whole reason the matcher keys on `constraint` and never on
    // `modelName`. `Room` has no template FK —
    // `ClassTemplate_teacherRoomId_roomArchived_fkey` is declared on
    // `TeacherRoom` — so this error can only arrive via
    // TeacherRoom_roomId_fkey's ON DELETE CASCADE
    // (`20260403092044_init/migration.sql:333`) taking the link on the way.
    //
    // `toBe('Room')`, not `not.toBe('TeacherRoom')`: a measured value exists,
    // and the negative form also passes if Prisma stops sending `modelName`
    // at all — the exact drift this block was added to catch.
    //
    // This is NOT the statement `DELETE /api/rooms/[id]` issues today; see the
    // route-sequence case below. It is the shape that route acquires the day
    // its redundant `teacherRoom.deleteMany` is removed.
    const f = await fx.makeFixture(prisma);
    await fx.addTemplate(prisma, f, { isActive: false, isArchived: true });

    const err = await refusalFrom(() => prisma.room.delete({ where: { id: f.roomId } }));

    const known = err as Prisma.PrismaClientKnownRequestError;
    expect(known.code).toBe('P2003');
    expect(known.meta?.constraint).toBe('ClassTemplate_teacherRoomId_roomArchived_fkey');
    expect(known.meta?.modelName).toBe('Room');
    expect(isRoomDeleteBlocked(err)).toBe(true);
  });

  it('the rooms route SEQUENCE reports modelName "TeacherRoom", not "Room"', async () => {
    // Mirrors `src/app/api/rooms/[id]/route.ts` exactly: deleteMany then
    // delete, inside one interactive transaction. Added in PR review, which
    // found every doc on this branch claiming that route emits `"Room"` — it
    // does not, because the `deleteMany` refuses first, and the cascade the
    // `"Room"` shape depends on never runs.
    //
    // Pinning the sequence rather than the statements matters twice over: it
    // is the only case covering a P2003 raised by a BATCH delete inside a
    // transaction, which is what the route actually catches in production.
    const f = await fx.makeFixture(prisma);
    await fx.addTemplate(prisma, f, { isActive: false, isArchived: true });

    const err = await refusalFrom(() =>
      prisma.$transaction(async (tx) => {
        await tx.teacherRoom.deleteMany({ where: { roomId: f.roomId } });
        await tx.room.delete({ where: { id: f.roomId } });
      }),
    );

    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const known = err as Prisma.PrismaClientKnownRequestError;
    expect(known.code).toBe('P2003');
    expect(known.meta?.constraint).toBe('ClassTemplate_teacherRoomId_roomArchived_fkey');
    expect(known.meta?.modelName).toBe('TeacherRoom');
    expect(isRoomDeleteBlocked(err)).toBe(true);
  });

  it('a teacherRoom delete blocked by a class reports Class_teacherRoomId_fkey', async () => {
    // The second name in ROOM_DELETE_RESTRICT_FKS. Listed there because the
    // `Class` guard has the identical check-to-delete race and had no backstop
    // before this issue — so it is the half most likely to be wrong and least
    // likely to be noticed.
    const f = await fx.makeFixture(prisma);
    await fx.addClass(prisma, f, 'completed');

    const err = await refusalFrom(() => prisma.teacherRoom.delete({ where: { id: f.linkId } }));

    const known = err as Prisma.PrismaClientKnownRequestError;
    expect(known.code).toBe('P2003');
    expect(known.meta?.constraint).toBe('Class_teacherRoomId_fkey');
    expect(isRoomDeleteBlocked(err)).toBe(true);
  });
});

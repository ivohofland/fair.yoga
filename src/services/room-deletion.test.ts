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

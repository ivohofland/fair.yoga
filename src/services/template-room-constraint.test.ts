import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const suffix = `troom-${Date.now()}`;
const accountIds: string[] = [];
let teacherId: string;
let roomId: string;
let openRoomId: string;
let shelvedRoomId: string;

/** SQLSTATE 23514 raised by `constraint`, in either Prisma error shape. */
function isCheck(err: unknown, constraint: string): boolean {
  const m = err instanceof Error ? err.message : '';
  return (m.includes('code: "23514"') || m.includes('Code: `23514`')) && m.includes(constraint);
}
/** SQLSTATE 23503 raised by `constraint` — a mirror that disagrees with its parent. */
function isFk(err: unknown, constraint: string): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
    return err.meta?.constraint === constraint;
  }
  const m = err instanceof Error ? err.message : '';
  return (m.includes('code: "23503"') || m.includes('Code: `23503`')) && m.includes(constraint);
}

const CHECK = 'ClassTemplate_live_needs_open_room';
const ROOM_FK = 'ClassTemplate_teacherRoomId_roomArchived_fkey';
const at = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00Z`);

async function makeRoom(tag: string, archived: boolean): Promise<string> {
  const room = await prisma.room.create({
    data: {
      venueName: `Venue ${tag}`, address: `${suffix} ${tag} Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: tag, maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  const link = await prisma.teacherRoom.create({
    data: { teacherId, roomId: room.id, rentalRate: 20, capacityOverride: 12, isArchived: archived },
  });
  return link.id;
}

/**
 * A rule and its template, at a weekday/time chosen per test so
 * `ScheduleRule_teacher_slot_excl` never fires and mask a result here.
 */
async function makeTemplate(
  dayOfWeek: number, teacherRoomId: string,
  opts: { isActive?: boolean; ruleLive?: boolean; roomArchived?: boolean; startTime?: string } = {},
): Promise<string> {
  const isActive = opts.isActive ?? true;
  const rule = await prisma.scheduleRule.create({
    data: {
      teacherId, kind: 'regular', classType: 'Yoga',
      dayOfWeek, startTime: at(opts.startTime ?? '19:00'), durationMinutes: 90, isActive,
    },
  });
  const tmpl = await prisma.classTemplate.create({
    data: {
      scheduleRuleId: rule.id, kind: 'regular', teacherRoomId,
      ruleLive: opts.ruleLive ?? isActive,
      roomArchived: opts.roomArchived ?? false,
      roomCost: 15, minRate: 10, targetRate: 20, minStudents: 2, maxStudents: 8,
    },
  });
  return tmpl.id;
}

beforeAll(async () => {
  await prisma.$connect();
  const email = `owner-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Room', lastName: 'Guard', email, bio: 'room invariant fixture',
      pageSlug: `owner-${suffix}`, account: { create: { email } },
    },
  });
  teacherId = t.id; accountIds.push(t.accountId);
  roomId = await makeRoom('base', false);
  openRoomId = await makeRoom('open', false);
  shelvedRoomId = await makeRoom('shelved', true);
});

afterAll(async () => {
  // Order matters: `ClassTemplate_teacherRoomId_roomArchived_fkey` is
  // ON DELETE RESTRICT, so templates must go before the rooms they point at.
  // Deleting the rules cascades the templates away.
  await prisma.scheduleRule.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { createdById: teacherId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('ClassTemplate_live_needs_open_room', () => {
  it('door 1: refuses archiving a room a LIVE template sits on', async () => {
    const room = await makeRoom('door1', false);
    await makeTemplate(1, room);
    await expect(
      prisma.teacherRoom.update({ where: { id: room }, data: { isArchived: true } }),
    ).rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 1b: ALLOWS archiving a room only a PAUSED template sits on', async () => {
    const room = await makeRoom('door1b', false);
    const tmpl = await makeTemplate(2, room, { isActive: false, ruleLive: false });
    await prisma.teacherRoom.update({ where: { id: room }, data: { isArchived: true } });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tmpl } });
    // The cascade carried the parent's new value down, without the app writing it.
    expect(after.roomArchived).toBe(true);
    expect(after.ruleLive).toBe(false);
  });

  it('door 3: refuses resuming a template whose room is archived', async () => {
    const room = await makeRoom('door3', false);
    const tmpl = await makeTemplate(3, room, { isActive: false, ruleLive: false });
    await prisma.teacherRoom.update({ where: { id: room }, data: { isArchived: true } });
    const { scheduleRuleId } = await prisma.classTemplate.findUniqueOrThrow({ where: { id: tmpl } });
    await expect(
      prisma.scheduleRule.update({ where: { id: scheduleRuleId }, data: { isActive: true } }),
    ).rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 4: refuses creating a LIVE template on an archived room', async () => {
    await expect(makeTemplate(4, shelvedRoomId, { roomArchived: true }))
      .rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 4: a create that ASSERTS the room is open fails on the FK, not the CHECK', async () => {
    // This is the shape `createClassTemplate` uses (Task 4): it writes
    // `roomArchived: false` rather than reading the room, so an archived room
    // has no matching parent key.
    await expect(makeTemplate(5, shelvedRoomId, { roomArchived: false }))
      .rejects.toSatisfy((e: unknown) => isFk(e, ROOM_FK));
  });

  it('door 5: refuses moving a LIVE template onto an archived room', async () => {
    const tmpl = await makeTemplate(6, openRoomId);
    await expect(prisma.classTemplate.update({
      where: { id: tmpl },
      data: { teacherRoomId: shelvedRoomId, roomArchived: true },
    })).rejects.toSatisfy((e: unknown) => isCheck(e, CHECK));
  });

  it('door 5b: ALLOWS moving a PAUSED template onto an archived room', async () => {
    const tmpl = await makeTemplate(0, openRoomId, { isActive: false, ruleLive: false });
    const moved = await prisma.classTemplate.update({
      where: { id: tmpl },
      data: { teacherRoomId: shelvedRoomId, roomArchived: true },
    });
    expect(moved.teacherRoomId).toBe(shelvedRoomId);
  });

  it('the mirror cannot lie: denying an archived room fails on the FK', async () => {
    // `dayOfWeek` 0 at 05:00: weekdays 0-6 already carry a rule each, and a
    // PAUSED template still holds its slot, so a second 19:00 rule on the
    // same weekday would collide with door 5b's under
    // `ScheduleRule_teacher_slot_excl` and mask the FK result.
    const tmpl = await makeTemplate(0, shelvedRoomId, {
      isActive: false, ruleLive: false, roomArchived: true, startTime: '05:00',
    });
    await expect(prisma.classTemplate.update({
      where: { id: tmpl }, data: { roomArchived: false },
    })).rejects.toSatisfy((e: unknown) => isFk(e, ROOM_FK));
  });
});
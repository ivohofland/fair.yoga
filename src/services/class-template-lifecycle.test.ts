import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { updateClassTemplate } from './class-template-lifecycle';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

describe('updateClassTemplate (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;
  let otherTeacherRoomId: string;

  const makeTemplate = (classType: string) =>
    prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: '09:30',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

  const seedTeacher = async (label: string) => {
    const email = `tpl-${label}-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: label,
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: `Teacher for ${label} template tests`,
        pageSlug: `tpl-${label}-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    const room = await prisma.room.create({
      data: {
        venueName: `${label} Venue`,
        address: `${uniqueSuffix} ${label} St`,
        city: 'Testville',
        postcode: '1234TP',
        floor: '1',
        roomName: 'Loft',
        maxCapacity: 10,
        createdById: teacher.id,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    return {
      teacherId: teacher.id,
      accountId: teacher.accountId,
      roomId: room.id,
      teacherRoomId: teacherRoom.id,
    };
  };

  beforeAll(async () => {
    await prisma.$connect();
    const mine = await seedTeacher('owner');
    teacherId = mine.teacherId;
    accountId = mine.accountId;
    roomId = mine.roomId;
    teacherRoomId = mine.teacherRoomId;

    const theirs = await seedTeacher('other');
    otherTeacherId = theirs.teacherId;
    otherAccountId = theirs.accountId;
    otherRoomId = theirs.roomId;
    otherTeacherRoomId = theirs.teacherRoomId;
  });

  afterAll(async () => {
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
    ] as const) {
      await prisma.class.deleteMany({ where: { teacherId: t } });
      await prisma.classTemplate.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await updateClassTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      { classType: 'Anything' },
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and writes nothing", async () => {
    const template = await makeTemplate('Not Yours');

    const result = await updateClassTemplate(prisma, template.id, otherTeacherId, {
      classType: 'Hijacked',
    });

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.classType).toBe('Not Yours');
  });

  it('returns no_fields for an empty payload', async () => {
    const template = await makeTemplate('Empty Payload');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {});
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
  });

  it('returns invalid_room for a room that does not exist', async () => {
    const template = await makeTemplate('Ghost Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it("returns invalid_room for another teacher's room, and writes nothing", async () => {
    const template = await makeTemplate('Someone Elses Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: otherTeacherRoomId,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it('applies the update and returns the sync result', async () => {
    const template = await makeTemplate('Editable');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      classType: 'Edited',
      durationMinutes: 75,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.classType).toBe('Edited');
    expect(result.template.durationMinutes).toBe(75);
    // No instances were generated for this bare template, so the sync is a
    // no-op — asserted as shape, not as counts.
    expect(result.sync).toEqual({ synced: 0, regenerated: 0, kept: 0 });
  });
});

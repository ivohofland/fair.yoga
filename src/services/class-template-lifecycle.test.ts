import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { RegistrationStatus } from '@prisma/client';
import { updateClassTemplate, archiveOrUnarchiveTemplate } from './class-template-lifecycle';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

// Hoisted to module scope: a pure function of `label` (plus the module-scope
// `prisma`/`uniqueSuffix` above), so both describe blocks below can seed their
// own, separate teacher/room/teacherRoom fixtures from it.
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

  it('returns no_fields for an empty payload, and writes nothing', async () => {
    const template = await makeTemplate('Empty Payload');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {});
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.classType).toBe('Empty Payload');
  });

  // Defined-value scan (class-template-lifecycle.ts:227): a key present with
  // value `undefined` is not an edit, unlike the key-count check this
  // replaced, which would have let this through as `ok: true` and run a
  // no-op update plus a full sync for nothing.
  it('returns no_fields for a payload of only undefined values, and writes nothing', async () => {
    const template = await makeTemplate('Undefined Only');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      description: undefined,
    });
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.classType).toBe('Undefined Only');
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
    // These counts are deterministic here — a bare template has no
    // instances, so the sync can only be a hard zero — unlike the API test,
    // which cannot pin an exact number without risking clock flakiness.
    expect(result.sync).toEqual({ synced: 0, regenerated: 0, kept: 0 });
  });
});

describe('archiveOrUnarchiveTemplate (DB)', () => {
  // Every case below is one row of the deletion rule. They are separate tests
  // rather than one sweep because when this breaks, which row broke is the
  // whole diagnosis.
  const DAY = 24 * 60 * 60 * 1000;
  const future = () => new Date(Date.now() + 5 * DAY);
  const past = () => new Date(Date.now() - 5 * DAY);
  const today = () => new Date();
  // `date` truncates to a calendar day and carries `@@unique([templateId,
  // date])`, so tests that put more than one class on the same template need
  // distinct days — plain `future()` called twice would collide.
  const futureOn = (daysFromNow: number) => new Date(Date.now() + daysFromNow * DAY);

  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;

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

  // Closes over the block's own teacherId/teacherRoomId, like the sibling
  // block's makeTemplate does.
  const makeClass = async (
    templateId: string,
    opts: { date: Date; status?: 'draft' | 'open' | 'cancelled' },
  ) =>
    prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        templateId,
        classType: 'Archive Rule',
        date: opts.date,
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: opts.status ?? 'open',
      },
    });

  const register = (classId: string, studentId: string, status: RegistrationStatus) =>
    prisma.registration.create({ data: { classId, studentId, tierAtBooking: 3, status } });

  beforeAll(async () => {
    await prisma.$connect();
    const seeded = await seedTeacher('archive');
    teacherId = seeded.teacherId;
    accountId = seeded.accountId;
    roomId = seeded.roomId;
    teacherRoomId = seeded.teacherRoomId;

    const student = await prisma.student.create({
      data: {
        firstName: 'Archive',
        lastName: 'Student',
        email: `archive-student-${uniqueSuffix}@test.local`,
      },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.classTemplate.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('deletes a future class nobody booked', async () => {
    const t = await makeTemplate('Del Unbooked');
    const c = await makeClass(t.id, { date: future() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('deletes a future class whose only registration is cancelled', async () => {
    const t = await makeTemplate('Del Cancelled');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'cancelled');

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    // Nobody is affected and nothing is owed, so this is not "booked".
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('keeps a future class with a late_cancel registration — it is still charged', async () => {
    const t = await makeTemplate('Keep LateCancel');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'late_cancel');

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    // ACTIVE_REGISTRATION_STATUSES excludes late_cancel; CHARGED_STATUSES does
    // not. Deleting this would cascade away a registration the student owes
    // for. If this test ever fails, check which constant the rule is using.
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it('keeps a future class with a registered student', async () => {
    const t = await makeTemplate('Keep Registered');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'registered');

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it("keeps today's class — the date > now boundary", async () => {
    const t = await makeTemplate('Keep Today');
    const c = await makeClass(t.id, { date: today() });

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it('keeps past classes', async () => {
    const t = await makeTemplate('Keep Past');
    const c = await makeClass(t.id, { date: past() });

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });

  it('reports deleted and remaining counts', async () => {
    const t = await makeTemplate('Counts');
    const unbooked1 = await makeClass(t.id, { date: futureOn(5) });
    const unbooked2 = await makeClass(t.id, { date: futureOn(6) });
    const booked = await makeClass(t.id, { date: futureOn(7) });
    await register(booked.id, studentId, 'registered');
    await makeClass(t.id, { date: past() });
    // Future, unbooked, but already `cancelled` — out of the archive rule's
    // scope entirely (scope is `draft`/`open`), so it must be swept into
    // neither the deleted count nor the remaining one.
    const alreadyCancelled = await makeClass(t.id, { date: futureOn(8), status: 'cancelled' });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.deleted).toBe(2);
    expect(result.remaining).toBe(1);
    expect(await prisma.class.count({ where: { id: unbooked1.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: unbooked2.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: booked.id } })).toBe(1);
    expect(await prisma.class.count({ where: { id: alreadyCancelled.id } })).toBe(1);
  });

  it('leaves the window untouched when un-archiving', async () => {
    const t = await makeTemplate('Archive Then Resume');
    const unbooked = await makeClass(t.id, { date: futureOn(5) });
    const booked = await makeClass(t.id, { date: futureOn(6) });
    await register(booked.id, studentId, 'registered');

    const archived = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error('expected ok');
    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(1);

    const survivingIds = (
      await prisma.class.findMany({ where: { templateId: t.id }, select: { id: true } })
    ).map((c) => c.id);

    const resumed = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    expect(resumed.deleted).toBe(0);
    expect(resumed.remaining).toBe(0);
    expect(resumed.template.isArchived).toBe(false);

    const stillSurviving = (
      await prisma.class.findMany({ where: { templateId: t.id }, select: { id: true } })
    ).map((c) => c.id);
    expect(new Set(stillSurviving)).toEqual(new Set(survivingIds));
    expect(await prisma.class.count({ where: { id: unbooked.id } })).toBe(0);
    expect(await prisma.class.count({ where: { id: booked.id } })).toBe(1);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const suffix = `slot-${Date.now()}`;
let teacherId: string;
let otherTeacherId: string;
const accountIds: string[] = [];

async function makeTeacher(tag: string): Promise<string> {
  const email = `${tag}-${suffix}@test.local`;
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Slot', lastName: tag, email, bio: 'slot constraint fixture',
      pageSlug: `${tag}-${suffix}`, account: { create: { email } },
    },
  });
  accountIds.push(t.accountId);
  return t.id;
}

let roomId: string;
let teacherRoomId: string;

const studio = (teacher: string, day: number) => ({
  teacherId: teacher, classType: 'Yoga', date: new Date(Date.UTC(2027, 0, day)),
  startTime: '09:00', durationMinutes: 60, location: 'Studio', hourlyRate: 40,
});

const cls = (teacher: string, day: number) => ({
  teacherId: teacher, teacherRoomId, classType: 'Yoga',
  date: new Date(Date.UTC(2027, 1, day)), startTime: '09:00', durationMinutes: 60,
  roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
});

const tpl = (teacher: string, day: number) => ({
  teacherId: teacher, teacherRoomId, classType: 'Yoga', dayOfWeek: day,
  startTime: '09:00', durationMinutes: 60, roomCost: 20, minRate: 30,
  targetRate: 60, minStudents: 3, maxStudents: 10,
});

const studioTpl = (teacher: string, day: number) => ({
  teacherId: teacher, classType: 'Yoga', dayOfWeek: day, startTime: '09:00',
  durationMinutes: 60, location: 'Studio', hourlyRate: 40,
});

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner');
  otherTeacherId = await makeTeacher('other');
  const room = await prisma.room.create({
    data: {
      venueName: 'Slot Venue', address: `${suffix} Slot Street`, city: 'Amsterdam',
      postcode: '1011AB', floor: '1', roomName: 'Main', maxCapacity: 12,
      isPublic: false, createdById: teacherId,
    },
  });
  roomId = room.id;
  const tr = await prisma.teacherRoom.create({
    // `capacityOverride` is required and has no default (schema.prisma).
    data: { teacherId, roomId, rentalRate: 20, capacityOverride: 12 },
  });
  teacherRoomId = tr.id;
});

afterAll(async () => {
  const teachers = [teacherId, otherTeacherId];
  await prisma.class.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.studioClass.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.classTemplate.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teachers } } });
  await prisma.room.deleteMany({ where: { createdById: { in: teachers } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teachers } } });
  // `Teacher.accountId` has no `onDelete: Cascade` (prisma/schema.prisma),
  // so the Account row each makeTeacher() created survives the teacher
  // delete above and must be removed separately, only after it — Account
  // is what Teacher.accountId references.
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

/**
 * These assert the DATABASE rejects the write. The route-level 409s in
 * tests/integration only prove a route's own branch; with the index absent
 * they would still pass on a sequential retry and fail only under a race,
 * which is the case that motivated #196.
 *
 * The assertions name `meta.target` — the column list — rather than matching
 * a message. A bare `rejects.toThrow()` would be satisfied by any masking
 * failure (an FK violation from a stale fixture, a different unique key).
 */
describe('teacher slot unique indexes', () => {
  it('rejects a second live studio class at the same teacher/date/startTime', async () => {
    await prisma.studioClass.create({ data: studio(teacherId, 4) });
    const err = await prisma.studioClass.create({ data: studio(teacherId, 4) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'date', 'startTime']);
  });

  it('does not block another teacher at the same date and time', async () => {
    // Seeds its own colliding row (day 6, distinct from the day-4 fixture
    // above) rather than relying on the preceding test's row: under the
    // Step 9 mutation that drops `teacherId` from the index, this is what
    // makes the assertion actually exercise the guard instead of vacuously
    // passing when run in isolation.
    await prisma.studioClass.create({ data: studio(teacherId, 6) });
    await expect(prisma.studioClass.create({ data: studio(otherTeacherId, 6) })).resolves.toBeTruthy();
  });

  it('a cancelled studio class does not block re-creating that slot', async () => {
    await prisma.studioClass.create({ data: { ...studio(teacherId, 5), cancelledAt: new Date() } });
    await expect(prisma.studioClass.create({ data: studio(teacherId, 5) })).resolves.toBeTruthy();
  });
});

describe('Class_teacher_slot_unique', () => {
  it('rejects a second live class at the same teacher/date/startTime', async () => {
    await prisma.class.create({ data: cls(teacherId, 4) });
    const err = await prisma.class.create({ data: cls(teacherId, 4) }).catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'date', 'startTime']);
  });

  it('a cancelled class does not block re-creating that slot', async () => {
    const c = await prisma.class.create({ data: cls(teacherId, 5) });
    // Created as `draft` then moved, because `class_terminal_status_guard`
    // governs status changes. If a direct `status: 'cancelled'` insert is
    // accepted, use it — but do not assume; run it and see.
    await prisma.class.update({ where: { id: c.id }, data: { status: 'cancelled' } });
    await expect(prisma.class.create({ data: cls(teacherId, 5) })).resolves.toBeTruthy();
  });

  // PR #208 review, E2. `StudioClass` and `Room_private` already had this
  // shape pinned; `Class`, `ClassTemplate` and `StudioClassTemplate` did not.
  // Seeds its own colliding row (day 6, distinct from the fixtures above)
  // rather than relying on a preceding test's row — self-seeded, so it
  // cannot pass vacuously if `teacherId` is ever dropped from the index.
  it('does not block another teacher at the same date and time', async () => {
    await prisma.class.create({ data: cls(teacherId, 6) });
    await expect(prisma.class.create({ data: cls(otherTeacherId, 6) })).resolves.toBeTruthy();
  });
});

describe('ClassTemplate_teacher_slot_unique', () => {
  it('rejects a second live template on the same teacher/dayOfWeek/startTime', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 1) });
    const err = await prisma.classTemplate.create({ data: tpl(teacherId, 1) }).catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'dayOfWeek', 'startTime']);
  });

  it('an archived template does not block a replacement on that slot', async () => {
    const t = await prisma.classTemplate.create({ data: tpl(teacherId, 2) });
    await prisma.classTemplate.update({ where: { id: t.id }, data: { isArchived: true } });
    await expect(prisma.classTemplate.create({ data: tpl(teacherId, 2) })).resolves.toBeTruthy();
  });

  // PR #208 review, E2. Self-seeded (see the class family's twin above), so
  // dropping `teacherId` from the index cannot pass this vacuously.
  it('does not block another teacher at the same dayOfWeek/startTime', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 3) });
    await expect(prisma.classTemplate.create({ data: tpl(otherTeacherId, 3) })).resolves.toBeTruthy();
  });
});

describe('StudioClassTemplate_teacher_slot_unique', () => {
  it('rejects a second live studio template on the same slot', async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 3) });
    const err = await prisma.studioClassTemplate
      .create({ data: studioTpl(teacherId, 3) }).catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'dayOfWeek', 'startTime']);
  });

  it('an archived studio template does not block a replacement', async () => {
    const t = await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 4) });
    await prisma.studioClassTemplate.update({ where: { id: t.id }, data: { isArchived: true } });
    await expect(prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 4) }))
      .resolves.toBeTruthy();
  });

  // PR #208 review, E2. Self-seeded (see the two twins above), so dropping
  // `teacherId` from the index cannot pass this vacuously.
  it('does not block another teacher at the same dayOfWeek/startTime', async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 5) });
    await expect(prisma.studioClassTemplate.create({ data: studioTpl(otherTeacherId, 5) }))
      .resolves.toBeTruthy();
  });
});

describe('Room identity indexes', () => {
  const room = (creator: string, isPublic: boolean, name: string) => ({
    venueName: 'V', address: `${suffix} Identity Street`, city: 'Amsterdam',
    postcode: '1011AB', floor: '3', roomName: name, maxCapacity: 10,
    isPublic, createdById: creator,
  });

  it('rejects a second public room with the same address/floor/roomName', async () => {
    await prisma.room.create({ data: room(teacherId, true, 'PubA') });
    const err = await prisma.room.create({ data: room(otherTeacherId, true, 'PubA') })
      .catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['address', 'floor', 'roomName']);
  });

  it('scopes private rooms per creator: same teacher twice is rejected', async () => {
    await prisma.room.create({ data: room(teacherId, false, 'PrivA') });
    const err = await prisma.room.create({ data: room(teacherId, false, 'PrivA') })
      .catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['createdById', 'address', 'floor', 'roomName']);
  });

  it('scopes private rooms per creator: a different teacher is allowed', async () => {
    // Seeds its own colliding row ('PrivB', distinct from the 'PrivA' row
    // above) rather than relying on the preceding test's row: under the
    // Step 9 mutation that drops `createdById` from the index, this is what
    // makes the assertion actually exercise the guard instead of vacuously
    // passing when run in isolation.
    await prisma.room.create({ data: room(teacherId, false, 'PrivB') });
    await expect(prisma.room.create({ data: room(otherTeacherId, false, 'PrivB') }))
      .resolves.toBeTruthy();
  });

  // PR #208 review, E1. `Room_private_identity_unique`'s `WHERE isPublic =
  // false` predicate was pinned by nothing: nothing proved a public and a
  // private room could share an identity. One creator, both arms, same
  // address/floor/roomName — each row enters only its own partial index
  // (`Room_public_identity_unique` needs `isPublic = true`,
  // `Room_private_identity_unique` needs `isPublic = false`), so neither
  // collides with the other. Delete the predicate from either index and this
  // goes red.
  it('lets one creator hold a public and a private room at the same address/floor/roomName', async () => {
    await prisma.room.create({ data: room(teacherId, true, 'DualScope') });
    await expect(prisma.room.create({ data: room(teacherId, false, 'DualScope') }))
      .resolves.toBeTruthy();
  });
});

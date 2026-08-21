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

describe('cross-family slot exclusivity (#296)', () => {
  const D = new Date(Date.UTC(2027, 5, 1));

  it('rejects a live studio class on a live class slot', async () => {
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D } });
    await expect(
      prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D } }),
    ).rejects.toThrow(/YG001/);
  });

  it('rejects a live class on a live studio class slot', async () => {
    const D2 = new Date(Date.UTC(2027, 5, 2));
    await prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D2 } });
    await expect(
      prisma.class.create({ data: { ...cls(teacherId, 1), date: D2 } }),
    ).rejects.toThrow(/YG001/);
  });

  it('a cancelled class does not block a studio class on that slot', async () => {
    const D3 = new Date(Date.UTC(2027, 5, 3));
    await prisma.class.create({
      data: { ...cls(teacherId, 1), date: D3, status: 'cancelled' },
    });
    const s = await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D3 },
    });
    expect(s.id).toBeTruthy();
  });

  it('a cancelled studio class does not block a class on that slot', async () => {
    const D4 = new Date(Date.UTC(2027, 5, 4));
    await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D4, cancelledAt: new Date() },
    });
    const c = await prisma.class.create({ data: { ...cls(teacherId, 1), date: D4 } });
    expect(c.id).toBeTruthy();
  });

  it('un-cancelling a studio class into an occupied slot is rejected', async () => {
    const D5 = new Date(Date.UTC(2027, 5, 5));
    const s = await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D5, cancelledAt: new Date() },
    });
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D5 } });
    await expect(
      prisma.studioClass.update({ where: { id: s.id }, data: { cancelledAt: null } }),
    ).rejects.toThrow(/YG001/);
  });

  it('does not block another teacher at the same date and time', async () => {
    const D6 = new Date(Date.UTC(2027, 5, 6));
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D6 } });
    const s = await prisma.studioClass.create({
      data: { ...studio(otherTeacherId, 1), date: D6 },
    });
    expect(s.id).toBeTruthy();
  });

  it('leaves a pre-existing violating pair editable on unrelated columns', async () => {
    const D7 = new Date(Date.UTC(2027, 5, 7));
    const c = await prisma.class.create({ data: { ...cls(teacherId, 1), date: D7 } });
    await prisma.$executeRaw`ALTER TABLE "StudioClass" DISABLE TRIGGER USER`;
    try {
      await prisma.$executeRaw`
        INSERT INTO "StudioClass"
          ("id","teacherId","classType","date","startTime","durationMinutes","location","hourlyRate","createdAt","updatedAt")
        VALUES
          (gen_random_uuid()::text, ${teacherId}, 'Yoga', ${D7}::date, '09:00', 60, 'Studio', 40, now(), now())`;
    } finally {
      await prisma.$executeRaw`ALTER TABLE "StudioClass" ENABLE TRIGGER USER`;
    }
    const updated = await prisma.class.update({
      where: { id: c.id },
      data: { description: 'edited while a violating pair stands' },
    });
    expect(updated.description).toBe('edited while a violating pair stands');

    // Prove the guard still fires: the DISABLE/ENABLE bracket above must not
    // have leaked, or every other test in this file would be silently voided.
    const D7b = new Date(Date.UTC(2027, 5, 8));
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D7b } });
    await expect(
      prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D7b } }),
    ).rejects.toThrow(/YG001/);
  });
});

// dayOfWeek 10-14 here, not 2-6: `ClassTemplate_teacher_slot_unique` and
// `StudioClassTemplate_teacher_slot_unique` above already leave teacherId
// holding live rows on days 1-3 (ClassTemplate) and 3-5 (StudioClassTemplate),
// and otherTeacherId on day 3 / day 5 respectively — nothing in this file
// cleans between describe blocks. Instance-level tests below sidestep the
// same problem by overriding `date` to disjoint June dates; templates have no
// such override, so distinct dayOfWeek values are what keeps these tests
// exercising the cross-family trigger instead of tripping the pre-existing
// single-table partial unique index (20260811202634) on an unrelated column.
describe('cross-family template slot exclusivity (#296)', () => {
  it('rejects a live studio template on a live class template slot', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 10) });
    await expect(
      prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 10) }),
    ).rejects.toThrow(/YG001/);
  });

  it('rejects a live class template on a live studio template slot', async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 11) });
    await expect(
      prisma.classTemplate.create({ data: tpl(teacherId, 11) }),
    ).rejects.toThrow(/YG001/);
  });

  it('an archived template does not block the sibling family', async () => {
    await prisma.classTemplate.create({ data: { ...tpl(teacherId, 12), isArchived: true } });
    const st = await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 12) });
    expect(st.id).toBeTruthy();
  });

  it('unarchiving into an occupied cross-family slot is rejected', async () => {
    const t = await prisma.classTemplate.create({
      data: { ...tpl(teacherId, 13), isArchived: true },
    });
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 13) });
    await expect(
      prisma.classTemplate.update({ where: { id: t.id }, data: { isArchived: false } }),
    ).rejects.toThrow(/YG001/);
  });

  it('does not block another teacher on the same dayOfWeek and startTime', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 14) });
    const st = await prisma.studioClassTemplate.create({ data: studioTpl(otherTeacherId, 14) });
    expect(st.id).toBeTruthy();
  });
});

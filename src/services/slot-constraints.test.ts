import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { hhmmToTime } from '@/lib/time-of-day';

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

type TplOverrides = { startTime?: string; isActive?: boolean; isArchived?: boolean };

const tpl = (teacher: string, day: number, overrides: TplOverrides = {}) => ({
  scheduleRule: {
    create: {
      teacherId: teacher, kind: 'regular' as const, classType: 'Yoga', dayOfWeek: day,
      startTime: hhmmToTime(overrides.startTime ?? '09:00'), durationMinutes: 60,
      ...(overrides.isActive !== undefined ? { isActive: overrides.isActive } : {}),
      ...(overrides.isArchived !== undefined ? { isArchived: overrides.isArchived } : {}),
    },
  },
  teacherRoom: { connect: { id: teacherRoomId } },
  roomCost: 20, minRate: 30, targetRate: 60, minStudents: 3, maxStudents: 10,
});

const studioTpl = (teacher: string, day: number, overrides: TplOverrides = {}) => ({
  scheduleRule: {
    create: {
      teacherId: teacher, kind: 'studio' as const, classType: 'Yoga', dayOfWeek: day,
      startTime: hhmmToTime(overrides.startTime ?? '09:00'), durationMinutes: 60,
      ...(overrides.isActive !== undefined ? { isActive: overrides.isActive } : {}),
      ...(overrides.isArchived !== undefined ? { isArchived: overrides.isArchived } : {}),
    },
  },
  location: 'Studio', hourlyRate: 40,
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
  // `ClassTemplate`/`StudioClassTemplate` are `onDelete: Cascade` from
  // `ScheduleRule` (issue 298), so deleting the rules removes both
  // families' templates with them.
  await prisma.scheduleRule.deleteMany({ where: { teacherId: { in: teachers } } });
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
    await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isArchived: true } });
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
    // day 6, not 3 (PR #296 review, C1/R5): day 3 at the shared '09:00'
    // startTime is where `ClassTemplate_teacher_slot_unique` above already
    // leaves teacherId holding a live ClassTemplate, and the cross-family
    // guard (20260821120000) now rejects a live StudioClassTemplate there —
    // this test wants the pre-existing single-table P2002, not that.
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 6) });
    const err = await prisma.studioClassTemplate
      .create({ data: studioTpl(teacherId, 6) }).catch((e: unknown) => e);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect((err as Prisma.PrismaClientKnownRequestError).meta?.target)
      .toEqual(['teacherId', 'dayOfWeek', 'startTime']);
  });

  it('an archived studio template does not block a replacement', async () => {
    const t = await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 4) });
    await prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isArchived: true } });
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

  // PR #296 review, I1. The "does not block another teacher" test above only
  // pins `studio_class_reject_cross_family_slot`'s own `teacherId` filter
  // (a live Class(teacherId) resident, a StudioClass(otherTeacherId) mover —
  // that fires the STUDIO-side function). Dropping `teacherId` from
  // `class_reject_cross_family_slot`'s WHERE reddened nothing before this
  // test existed. This is the opposite pairing: a live StudioClass belonging
  // to a DIFFERENT teacher must not stop `teacherId` from taking the same
  // date/startTime.
  it('does not block a class from another teacher\'s studio class at the same slot', async () => {
    const D8 = new Date(Date.UTC(2027, 5, 9));
    await prisma.studioClass.create({ data: { ...studio(otherTeacherId, 1), date: D8 } });
    const c = await prisma.class.create({ data: { ...cls(teacherId, 1), date: D8 } });
    expect(c.id).toBeTruthy();
  });

  // PR #296 review, I3. Nothing anywhere moved a `date`/`startTime` into an
  // occupied cross-family slot, so the slot-move disjuncts of both
  // instance-level UPDATE `WHEN` clauses were dead to this suite. Two tests,
  // one per disjunct (moving `date` here, `startTime` in the mirror below) —
  // covering the same field twice would leave the other permanently
  // unproven.
  it('moving a class into an occupied cross-family slot is rejected', async () => {
    const D9 = new Date(Date.UTC(2027, 5, 10)); // resident StudioClass's date
    const D10 = new Date(Date.UTC(2027, 5, 11)); // mover Class's starting date
    await prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D9 } });
    const c = await prisma.class.create({ data: { ...cls(teacherId, 1), date: D10 } });
    await expect(
      prisma.class.update({ where: { id: c.id }, data: { date: D9 } }),
    ).rejects.toThrow(/YG001/);
  });

  it('moving a studio class into an occupied cross-family slot is rejected', async () => {
    const D11 = new Date(Date.UTC(2027, 5, 12));
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D11 } });
    const s = await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D11, startTime: '08:00' },
    });
    await expect(
      prisma.studioClass.update({ where: { id: s.id }, data: { startTime: '09:00' } }),
    ).rejects.toThrow(/YG001/);
  });

  /**
   * PR #300 review, G2. The pair above is one-sided: the `Class` side is
   * covered in BOTH fields (`date` above, `startTime` at
   * `cross-family-slot-api.test.ts`), while the `StudioClass` side only ever
   * moves `startTime` — here and in the integration suite. So
   * `studio_class_cross_family_slot_update_guard`'s
   * `OLD."date" IS DISTINCT FROM NEW."date"` disjunct had no test at any layer,
   * and `PUT /api/studio-classes/[id]` is a live door onto it.
   *
   * The comment above says the two tests exist "one per disjunct… covering the
   * same field twice would leave the other permanently unproven" — which is
   * right, and was applied per-FAMILY where it needed to be applied per-family-
   * per-field.
   */
  it('moving a studio class by DATE into an occupied cross-family slot is rejected', async () => {
    const D12 = new Date(Date.UTC(2027, 5, 13)); // resident Class's date
    const D13 = new Date(Date.UTC(2027, 5, 14)); // mover StudioClass's date
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D12, startTime: '08:15' } });
    const s = await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D13, startTime: '08:15' },
    });
    await expect(
      prisma.studioClass.update({ where: { id: s.id }, data: { date: D12 } }),
    ).rejects.toThrow(/YG001/);
  });

  it('moving a class by startTime into an occupied cross-family slot is rejected', async () => {
    // The fourth cell of the family x field matrix, so no disjunct on either
    // instance trigger is left resting on the other family's coverage.
    const D14 = new Date(Date.UTC(2027, 5, 15));
    await prisma.studioClass.create({
      data: { ...studio(teacherId, 1), date: D14, startTime: '08:30' },
    });
    const c = await prisma.class.create({
      data: { ...cls(teacherId, 1), date: D14, startTime: '08:45' },
    });
    await expect(
      prisma.class.update({ where: { id: c.id }, data: { startTime: '08:30' } }),
    ).rejects.toThrow(/YG001/);
  });

  // PR #296 review, I4 (the `Class` half — the `StudioClass` half already had
  // "un-cancelling a studio class..." above). A direct `status: 'cancelled'`
  // insert is used, as the "a cancelled class does not block..." test above
  // already established works for this table.
  //
  // `class_terminal_status_guard` (20260805120000) also blocks EVERY
  // cancelled -> non-cancelled status change, unconditionally — so this
  // update is refused either way. What proves the became-live disjunct
  // specifically is WHICH error surfaces: Postgres fires same-table BEFORE
  // ROW triggers in alphabetical name order, and
  // `class_cross_family_slot_update_guard` sorts before
  // `class_terminal_status_guard` ('r' < 't' at the first difference), so
  // the occupied-slot case raises YG001 before the terminal-status trigger
  // ever runs. Drop the became-live disjunct and this specific assertion
  // goes red (the update is still refused, but with the terminal-status
  // trigger's 23514 instead) even though the update remains rejected either
  // way — which is exactly why this needs its own test rather than folding
  // into the terminal-status suite.
  it('un-cancelling a class into an occupied cross-family slot is rejected', async () => {
    const D12 = new Date(Date.UTC(2027, 5, 13));
    await prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D12 } });
    const c = await prisma.class.create({
      data: { ...cls(teacherId, 1), date: D12, status: 'cancelled' },
    });
    await expect(
      prisma.class.update({ where: { id: c.id }, data: { status: 'draft' } }),
    ).rejects.toThrow(/YG001/);
  });

  // PR #296 review, mutation W2 finding. "leaves a pre-existing violating
  // pair editable on unrelated columns" above only pins the narrowness of
  // `class_cross_family_slot_update_guard`'s own `WHEN` — reducing the
  // SIBLING trigger's `WHEN` (`studio_class_cross_family_slot_update_guard`)
  // to its liveness term alone reddened nothing until this test existed, for
  // the same reason W1 caught `class_cross_family_slot_update_guard`'s
  // reduction: dropping the extra conjunct WIDENS when a trigger fires
  // (it stops excluding "nothing relevant changed"), so only an
  // unrelated-column-edit-stays-editable test can catch it — a
  // slot-move/became-live rejection test cannot, since widening a WHEN never
  // removes coverage those already exercise.
  it('leaves a pre-existing violating pair editable on unrelated columns (studio class)', async () => {
    const D13 = new Date(Date.UTC(2027, 5, 14));
    const s = await prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D13 } });
    await prisma.$executeRaw`ALTER TABLE "Class" DISABLE TRIGGER USER`;
    try {
      await prisma.class.create({ data: { ...cls(teacherId, 1), date: D13 } });
    } finally {
      await prisma.$executeRaw`ALTER TABLE "Class" ENABLE TRIGGER USER`;
    }
    const updated = await prisma.studioClass.update({
      where: { id: s.id },
      data: { location: 'edited while a violating pair stands' },
    });
    expect(updated.location).toBe('edited while a violating pair stands');

    // Prove the guard still fires: the DISABLE/ENABLE bracket above must not
    // have leaked.
    const D13b = new Date(Date.UTC(2027, 5, 15));
    await prisma.class.create({ data: { ...cls(teacherId, 1), date: D13b } });
    await expect(
      prisma.studioClass.create({ data: { ...studio(teacherId, 1), date: D13b } }),
    ).rejects.toThrow(/YG001/);
  });
});

// PR #296 review, M1/R7. The first draft of this block reused dayOfWeek
// 10-14 to dodge the live rows `ClassTemplate_teacher_slot_unique` and
// `StudioClassTemplate_teacher_slot_unique` above leave teacherId holding on
// days 1-3 / 4-6 (both at the factories' default startTime '09:00') — values
// outside a real day-of-week's 0-6 domain, which only worked because nothing
// CHECK-constrains the column, and would break the day one does. `startTime`
// is the axis this block claims instead: every test below runs at '10:00' or
// '11:00', never '09:00', which is what actually keeps it clear of the
// single-family fixtures — freeing dayOfWeek 0-6 to be used honestly.
describe('cross-family template slot exclusivity (#296)', () => {
  it('rejects a live studio template on a live class template slot', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 0, { startTime: '10:00' }) });
    await expect(
      prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 0, { startTime: '10:00' }) }),
    ).rejects.toThrow(/YG001/);
  });

  it('rejects a live class template on a live studio template slot', async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 1, { startTime: '10:00' }) });
    await expect(
      prisma.classTemplate.create({ data: tpl(teacherId, 1, { startTime: '10:00' }) }),
    ).rejects.toThrow(/YG001/);
  });

  it('an archived class template does not block the sibling studio family', async () => {
    await prisma.classTemplate.create({
      data: tpl(teacherId, 2, { startTime: '10:00', isArchived: true }),
    });
    const st = await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 2, { startTime: '10:00' }),
    });
    expect(st.id).toBeTruthy();
  });

  // PR #296 review, I2. The test above only pins the liveness predicate on
  // `studio_class_template_reject_cross_family_slot`'s own lookup (it reads
  // `ClassTemplate`, filtered `isArchived = false`). This is the mirror,
  // pinning `class_template_reject_cross_family_slot`'s `AND "isArchived" =
  // false` on its `StudioClassTemplate` lookup — dropping that predicate
  // reddened nothing before this test existed.
  it('an archived studio template does not block the sibling class family', async () => {
    await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 5, { startTime: '10:00', isArchived: true }),
    });
    const t = await prisma.classTemplate.create({ data: tpl(teacherId, 5, { startTime: '10:00' }) });
    expect(t.id).toBeTruthy();
  });

  it('unarchiving a class template into an occupied cross-family slot is rejected', async () => {
    const t = await prisma.classTemplate.create({
      data: tpl(teacherId, 3, { startTime: '10:00', isArchived: true }),
    });
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 3, { startTime: '10:00' }) });
    await expect(
      prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { isArchived: false } }),
    ).rejects.toThrow(/YG001/);
  });

  // PR #296 review, I4 (the `StudioClassTemplate` half — the `ClassTemplate`
  // half is the test above). Mirrors it, pinning the became-live disjunct of
  // `studio_class_template_cross_family_slot_update_guard`, which had no
  // rejection coverage in either direction before this test existed.
  it('unarchiving a studio template into an occupied cross-family slot is rejected', async () => {
    const st = await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 6, { startTime: '10:00', isArchived: true }),
    });
    await prisma.classTemplate.create({ data: tpl(teacherId, 6, { startTime: '10:00' }) });
    await expect(
      prisma.scheduleRule.update({ where: { id: st.scheduleRuleId }, data: { isArchived: false } }),
    ).rejects.toThrow(/YG001/);
  });

  it('does not block another teacher on the same dayOfWeek and startTime', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 4, { startTime: '10:00' }) });
    const st = await prisma.studioClassTemplate.create({
      data: studioTpl(otherTeacherId, 4, { startTime: '10:00' }),
    });
    expect(st.id).toBeTruthy();
  });

  // PR #296 review, mutation F5 finding — the template-level mirror of I1.
  // The test above only pins `studio_class_template_reject_cross_family_slot`'s
  // own `teacherId` filter (a live ClassTemplate(teacherId) resident, a
  // StudioClassTemplate(otherTeacherId) mover — that fires the STUDIO-side
  // function on ITS insert). Dropping `teacherId` from
  // `class_template_reject_cross_family_slot`'s WHERE reddened nothing until
  // this test existed. This is the opposite pairing: a live studio template
  // belonging to a DIFFERENT teacher must not stop `teacherId` from taking
  // the same dayOfWeek/startTime.
  it("does not block a class template from another teacher's studio template at the same slot", async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(otherTeacherId, 4, { startTime: '11:00' }) });
    const t = await prisma.classTemplate.create({ data: tpl(teacherId, 4, { startTime: '11:00' }) });
    expect(t.id).toBeTruthy();
  });

  // PR #296 review, I3. Nothing anywhere moved a `dayOfWeek` into an occupied
  // cross-family slot, so the slot-move disjuncts of both template-level
  // UPDATE `WHEN` clauses were dead to this suite. `startTime` '11:00' here,
  // not '10:00': each of these needs two free dayOfWeek values (a resident
  // and a mover), and reusing 0-3 at a third startTime is simpler than
  // hunting for four more values in the 0-6 domain.
  it('moving a class template into an occupied cross-family slot is rejected', async () => {
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 0, { startTime: '11:00' }) });
    const t = await prisma.classTemplate.create({ data: tpl(teacherId, 1, { startTime: '11:00' }) });
    await expect(
      prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { dayOfWeek: 0 } }),
    ).rejects.toThrow(/YG001/);
  });

  it('moving a studio template into an occupied cross-family slot is rejected', async () => {
    await prisma.classTemplate.create({ data: tpl(teacherId, 2, { startTime: '11:00' }) });
    const st = await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 3, { startTime: '11:00' }),
    });
    await expect(
      prisma.scheduleRule.update({ where: { id: st.scheduleRuleId }, data: { dayOfWeek: 2 } }),
    ).rejects.toThrow(/YG001/);
  });

  /**
   * PR #300 review, G1 — the highest-value gap the review found.
   *
   * Both template UPDATE `WHEN` clauses carry
   * `OLD."startTime" IS DISTINCT FROM NEW."startTime"`, and NOTHING exercised
   * it: the two cases above both move `dayOfWeek`, and so do both integration
   * cases. Deleting that disjunct from either trigger left the whole suite
   * green while a `startTime` move onto an occupied cross-family slot was
   * accepted — and templates have no route pre-check, so the trigger is the
   * only guard there. Moving a recurring class's TIME is also the more ordinary
   * teacher edit of the two.
   *
   * The instance block above already understood this hazard and wrote it down
   * ("Two tests, one per disjunct… covering the same field twice would leave
   * the other permanently unproven"); the template block then covered the same
   * field twice. `startTime` '13:00'/'13:30' here: a fourth and fifth reserved
   * pair, clear of '09:00', '10:00', '11:00' and '12:00'.
   */
  it('moving a class template by startTime into an occupied cross-family slot is rejected', async () => {
    await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 5, { startTime: '13:00' }),
    });
    const t = await prisma.classTemplate.create({
      data: tpl(teacherId, 5, { startTime: '13:30' }),
    });
    await expect(
      prisma.scheduleRule.update({ where: { id: t.scheduleRuleId }, data: { startTime: hhmmToTime('13:00') } }),
    ).rejects.toThrow(/YG001/);
  });

  it('moving a studio template by startTime into an occupied cross-family slot is rejected', async () => {
    await prisma.classTemplate.create({
      data: tpl(teacherId, 6, { startTime: '13:00' }),
    });
    const st = await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 6, { startTime: '13:30' }),
    });
    await expect(
      prisma.scheduleRule.update({ where: { id: st.scheduleRuleId }, data: { startTime: hhmmToTime('13:00') } }),
    ).rejects.toThrow(/YG001/);
  });

  /**
   * PR #300 review, G7. The migration states the decision — "`isActive`
   * (paused) is NOT consulted: a paused template goes on holding its slot" —
   * and all four template lookups filter on `isArchived` alone. Nothing pinned
   * it: every template fixture in this file is `isActive: true` by default.
   *
   * Adding `AND "isActive" = true` to a lookup reddens nothing today, and the
   * consequence is not a transient one: `isActive` is not in the `WHEN` clause
   * either, so RESUMING the paused template never re-fires the guard. You land
   * on two live templates at one slot, permanently — a state the migration's
   * own pre-flight check would have refused to install over.
   */
  it('a PAUSED but unarchived class template still holds its slot against the other family', async () => {
    await prisma.classTemplate.create({
      data: tpl(teacherId, 0, { startTime: '14:00', isActive: false, isArchived: false }),
    });
    await expect(
      prisma.studioClassTemplate.create({
        data: studioTpl(teacherId, 0, { startTime: '14:00' }),
      }),
    ).rejects.toThrow(/YG001/);
  });

  it('a PAUSED but unarchived studio template still holds its slot against the other family', async () => {
    await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 1, { startTime: '14:00', isActive: false, isArchived: false }),
    });
    await expect(
      prisma.classTemplate.create({ data: tpl(teacherId, 1, { startTime: '14:00' }) }),
    ).rejects.toThrow(/YG001/);
  });

  // PR #296 review, mutation W3/W4 finding — the template-level twins of the
  // instance-level "leaves a pre-existing violating pair editable..." tests
  // above. `startTime` '12:00' here: a third reserved value, alongside '10:00'
  // and '11:00', for the same reason those two exist — clear of the '09:00'
  // single-family fixtures and of each other.
  it('leaves a pre-existing violating pair of templates editable on unrelated columns (class template)', async () => {
    const t = await prisma.classTemplate.create({ data: tpl(teacherId, 0, { startTime: '12:00' }) });
    await prisma.$executeRaw`ALTER TABLE "StudioClassTemplate" DISABLE TRIGGER USER`;
    try {
      await prisma.studioClassTemplate.create({
        data: studioTpl(teacherId, 0, { startTime: '12:00' }),
      });
    } finally {
      await prisma.$executeRaw`ALTER TABLE "StudioClassTemplate" ENABLE TRIGGER USER`;
    }
    const updated = await prisma.classTemplate.update({
      where: { id: t.id },
      data: { description: 'edited while a violating pair stands' },
    });
    expect(updated.description).toBe('edited while a violating pair stands');

    // Prove the guard still fires: the DISABLE/ENABLE bracket above must not
    // have leaked.
    await prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 1, { startTime: '12:00' }) });
    await expect(
      prisma.classTemplate.create({ data: tpl(teacherId, 1, { startTime: '12:00' }) }),
    ).rejects.toThrow(/YG001/);
  });

  it('leaves a pre-existing violating pair of templates editable on unrelated columns (studio template)', async () => {
    const st = await prisma.studioClassTemplate.create({
      data: studioTpl(teacherId, 2, { startTime: '12:00' }),
    });
    await prisma.$executeRaw`ALTER TABLE "ClassTemplate" DISABLE TRIGGER USER`;
    try {
      await prisma.classTemplate.create({ data: tpl(teacherId, 2, { startTime: '12:00' }) });
    } finally {
      await prisma.$executeRaw`ALTER TABLE "ClassTemplate" ENABLE TRIGGER USER`;
    }
    const updated = await prisma.studioClassTemplate.update({
      where: { id: st.id },
      data: { location: 'edited while a violating pair stands' },
    });
    expect(updated.location).toBe('edited while a violating pair stands');

    // Prove the guard still fires: the DISABLE/ENABLE bracket above must not
    // have leaked.
    await prisma.classTemplate.create({ data: tpl(teacherId, 3, { startTime: '12:00' }) });
    await expect(
      prisma.studioClassTemplate.create({ data: studioTpl(teacherId, 3, { startTime: '12:00' }) }),
    ).rejects.toThrow(/YG001/);
  });
});

/**
 * `updateTeacherProfile` (#758): a plain save, a save that names a currency,
 * and the rule that a currency save commits or rolls back as one. The races
 * against an erasure are in `src/app/api/teachers/[id]/route-lock-order.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun, type RoomFixture } from '../../tests/room-fixtures';
import { createClassFixture } from '../../tests/class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { updateTeacherProfile, TeacherProfileInvariantError } from './teacher-profile';

const prisma = new PrismaClient();
const fx = fixtureRun('tprof');

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

async function utcTeacher(): Promise<RoomFixture> {
  const f = await fx.makeFixture(prisma);
  await prisma.teacher.update({ where: { id: f.teacherId }, data: { defaultTimezone: 'UTC' } });
  return f;
}

function openClass(f: RoomFixture) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 10);
  return createClassFixture(prisma, {
    teacherId: f.teacherId,
    teacherRoomId: f.linkId,
    classType: 'Vinyasa',
    date,
    startTime: hhmmToTime('10:00'),
    durationMinutes: 60,
    roomCost: new Prisma.Decimal(20),
    minRate: new Prisma.Decimal(15),
    targetRate: new Prisma.Decimal(25),
    minStudents: 2,
    maxStudents: 10,
    status: 'open',
  });
}

async function stored(teacherId: string) {
  return prisma.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { bio: true, currency: true } });
}

async function classCurrency(id: string) {
  return (await prisma.class.findUniqueOrThrow({ where: { id }, select: { currency: true } })).currency;
}

describe('updateTeacherProfile (#758)', () => {
  it('saves the fields of a plain save, with no switch', async () => {
    const f = await utcTeacher();
    const outcome = await updateTeacherProfile(prisma, f.teacherId, { fields: { bio: 'plain' } });
    expect(outcome).toMatchObject({ kind: 'saved', teacher: { bio: 'plain' } });
    expect(outcome).not.toHaveProperty('currencySwitch');
  });

  it('answers gone for an erased teacher and writes nothing', async () => {
    const f = await utcTeacher();
    await prisma.teacher.update({ where: { id: f.teacherId }, data: { bio: 'erased', deletedAt: new Date() } });

    expect(await updateTeacherProfile(prisma, f.teacherId, { fields: { bio: 'plain' } })).toEqual({ kind: 'gone' });
    expect(
      await updateTeacherProfile(prisma, f.teacherId, { currency: 'GBP', fields: { bio: 'switched' } }),
    ).toEqual({ kind: 'gone' });
    expect(await stored(f.teacherId)).toEqual({ bio: 'erased', currency: 'EUR' });
  });

  it('switches, writes the other fields, and answers what the switch did', async () => {
    const f = await utcTeacher();
    const cls = await openClass(f);

    const outcome = await updateTeacherProfile(prisma, f.teacherId, { currency: 'GBP', fields: { bio: 'both' } });

    expect(outcome).toMatchObject({
      kind: 'saved',
      teacher: { bio: 'both', currency: 'GBP' },
      currencySwitch: { relabelled: { classes: 1, studioClasses: 0 }, kept: [] },
    });
    expect(await classCurrency(cls.id)).toBe('GBP');
  });

  it('answers unchanged for the stored currency alone, and saves without a switch beside other fields', async () => {
    const f = await utcTeacher();

    expect(await updateTeacherProfile(prisma, f.teacherId, { currency: 'EUR', fields: {} })).toMatchObject({
      kind: 'unchanged',
      teacher: { currency: 'EUR' },
    });
    const withFields = await updateTeacherProfile(prisma, f.teacherId, { currency: 'EUR', fields: { bio: 'same' } });
    expect(withFields).toMatchObject({ kind: 'saved', teacher: { bio: 'same', currency: 'EUR' } });
    expect(withFields).not.toHaveProperty('currencySwitch');
  });

  it('rolls the switch back when the database refuses another field', async () => {
    const f = await utcTeacher();
    const other = await utcTeacher();
    const taken = (await prisma.teacher.findUniqueOrThrow({ where: { id: other.teacherId }, select: { pageSlug: true } })).pageSlug;
    const cls = await openClass(f);

    await expect(
      updateTeacherProfile(prisma, f.teacherId, { currency: 'GBP', fields: { pageSlug: taken } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect((await stored(f.teacherId)).currency).toBe('EUR');
    expect(await classCurrency(cls.id)).toBe('EUR');
  });

  // Unreachable while the switch's lock reads the row live; forced here so a
  // miss is shown to roll the switch back rather than commit it beside a 404.
  it('throws, and rolls the switch back, when the fields write misses the row it holds', async () => {
    const f = await utcTeacher();
    const cls = await openClass(f);
    const missing = prisma.$extends({
      query: { teacher: { updateMany: async () => ({ count: 0 }) } },
    }) as unknown as PrismaClient;

    await expect(
      updateTeacherProfile(missing, f.teacherId, { currency: 'GBP', fields: { bio: 'lost' } }),
    ).rejects.toBeInstanceOf(TeacherProfileInvariantError);
    expect((await stored(f.teacherId)).currency).toBe('EUR');
    expect(await classCurrency(cls.id)).toBe('EUR');
  });
});

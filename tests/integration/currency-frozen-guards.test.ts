/**
 * The database half of the currency freeze (#758, spec A2): a `Class` that is
 * booked, completed or cancelled, and a `StudioClass` dated before yesterday,
 * refuse a `currency` change whoever writes it. The switch's own `where`
 * (`currency-switch.test.ts`) keeps it inside what these triggers allow.
 *
 * Every teacher is in `UTC`: the studio rows are dated relative to the real
 * today.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun, type RoomFixture } from '../room-fixtures';
import { createClassFixture, createStudioClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const fx = fixtureRun('curfrz');

beforeAll(async () => {
  await prisma.$connect();
});
afterAll(async () => {
  await fx.cleanup(prisma);
  await prisma.$disconnect();
});

function utcDay(offset: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

async function utcTeacher(): Promise<RoomFixture> {
  const f = await fx.makeFixture(prisma);
  await prisma.teacher.update({ where: { id: f.teacherId }, data: { defaultTimezone: 'UTC' } });
  return f;
}

function classAt(f: RoomFixture, daysAhead: number, own: Partial<Prisma.ClassUncheckedCreateInput> = {}) {
  return createClassFixture(prisma, {
    teacherId: f.teacherId,
    teacherRoomId: f.linkId,
    classType: 'Vinyasa',
    date: utcDay(daysAhead),
    startTime: hhmmToTime('10:00'),
    durationMinutes: 60,
    roomCost: new Prisma.Decimal(20),
    minRate: new Prisma.Decimal(15),
    targetRate: new Prisma.Decimal(25),
    minStudents: 2,
    maxStudents: 10,
    status: 'open',
    ...own,
  });
}

function studioAt(f: RoomFixture, daysAhead: number) {
  return createStudioClassFixture(prisma, {
    teacherId: f.teacherId,
    classType: 'Studio flow',
    date: utcDay(daysAhead),
    startTime: hhmmToTime('19:00'),
    durationMinutes: 60,
    location: 'Gym',
    hourlyRate: new Prisma.Decimal(40),
  });
}

async function setClassCurrency(id: string) {
  return prisma.class.update({ where: { id }, data: { currency: 'GBP' } });
}

describe('class_currency_frozen_guard', () => {
  it('refuses a currency change on a settingsLocked class', async () => {
    const f = await utcTeacher();
    const c = await classAt(f, 10, { settingsLocked: true });
    await expect(setClassCurrency(c.id)).rejects.toThrow(/cannot change its currency/);
    expect((await prisma.class.findUniqueOrThrow({ where: { id: c.id } })).currency).toBe('EUR');
  });

  it('refuses a currency change on a completed class', async () => {
    const f = await utcTeacher();
    const c = await classAt(f, -3, { status: 'completed' });
    await expect(setClassCurrency(c.id)).rejects.toThrow(/cannot change its currency/);
  });

  it('refuses a currency change on a cancelled class', async () => {
    const f = await utcTeacher();
    const c = await classAt(f, 11);
    await prisma.calendarEntry.update({ where: { id: c.calendarEntryId }, data: { cancelledAt: new Date() } });
    await expect(setClassCurrency(c.id)).rejects.toThrow(/cannot change its currency/);
  });

  it('allows a currency change on an unlocked open class', async () => {
    const f = await utcTeacher();
    const c = await classAt(f, 12);
    const updated = await setClassCurrency(c.id);
    expect(updated.currency).toBe('GBP');
  });

  it('allows a write that leaves the currency as it is on a frozen class', async () => {
    const f = await utcTeacher();
    const c = await classAt(f, 14, { settingsLocked: true });
    const updated = await prisma.class.update({ where: { id: c.id }, data: { currency: 'EUR' } });
    expect(updated.currency).toBe('EUR');
  });
});

describe('studio_class_currency_frozen_guard', () => {
  it('refuses a currency change on a studio class dated three days ago', async () => {
    const f = await utcTeacher();
    const s = await studioAt(f, -3);
    await expect(
      prisma.studioClass.update({ where: { id: s.id }, data: { currency: 'GBP' } }),
    ).rejects.toThrow(/cannot change its currency/);
    expect((await prisma.studioClass.findUniqueOrThrow({ where: { id: s.id } })).currency).toBe('EUR');
  });

  it('allows a currency change on a studio class dated tomorrow', async () => {
    const f = await utcTeacher();
    const s = await studioAt(f, 1);
    const updated = await prisma.studioClass.update({ where: { id: s.id }, data: { currency: 'GBP' } });
    expect(updated.currency).toBe('GBP');
  });
});

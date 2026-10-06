/**
 * `switchTeacherCurrency` (#758, spec A2): which of a teacher's rows a switch
 * relabels, which it keeps, and that it reaches no other teacher's rows. The
 * races against a booking, a generation and a create are in
 * `currency-switch-lock-order.test.ts`.
 *
 * Every teacher here is in `UTC`: the studio rows sit one day either side of
 * the real today, and the service reads "today" from the teacher's zone.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { fixtureRun, type RoomFixture } from '../../tests/room-fixtures';
import { createClassFixture, createStudioClassFixture } from '../../tests/class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { switchTeacherCurrency } from './currency-switch';

const prisma = new PrismaClient();
const fx = fixtureRun('cursw');

beforeAll(async () => { await prisma.$connect(); });
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

async function currencies(ids: { classes: string[]; studio: string[] }) {
  const [classes, studio] = await Promise.all([
    prisma.class.findMany({ where: { id: { in: ids.classes } }, select: { id: true, currency: true } }),
    prisma.studioClass.findMany({ where: { id: { in: ids.studio } }, select: { id: true, currency: true } }),
  ]);
  return Object.fromEntries([...classes, ...studio].map((r) => [r.id, r.currency]));
}

/** One teacher holding every shape the switch has to tell apart. */
async function mixedTeacher() {
  const f = await utcTeacher();
  const draft = await classAt(f, 10, { status: 'draft' });
  const openUnbooked = await classAt(f, 11);
  const openBooked = await classAt(f, 12, { settingsLocked: true });
  const completed = await classAt(f, -3, { status: 'completed' });
  const cancelled = await classAt(f, 13);
  // Cancelled the way the app cancels one: on the entry, which carries
  // `entryLive` down to the class.
  await prisma.calendarEntry.update({
    where: { id: cancelled.calendarEntryId },
    data: { cancelledAt: new Date() },
  });
  const studioYesterday = await studioAt(f, -1);
  const studioTomorrow = await studioAt(f, 1);
  return { f, draft, openUnbooked, openBooked, completed, cancelled, studioYesterday, studioTomorrow };
}

describe('switchTeacherCurrency (#758)', () => {
  it('relabels the unbooked, unfinished, live classes and the studio classes from today on', async () => {
    const t = await mixedTeacher();
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: t.cancelled.id }, select: { entryLive: true } })).entryLive,
    ).toBe(false);

    const result = await prisma.$transaction((tx) => switchTeacherCurrency(tx, t.f.teacherId, 'GBP'));

    expect(result).toEqual({
      relabelled: { classes: 2, studioClasses: 1 },
      kept: { classes: 3, studioClasses: 1 },
    });
    expect(
      await currencies({
        classes: [t.draft.id, t.openUnbooked.id, t.openBooked.id, t.completed.id, t.cancelled.id],
        studio: [t.studioYesterday.id, t.studioTomorrow.id],
      }),
    ).toEqual({
      [t.draft.id]: 'GBP',
      [t.openUnbooked.id]: 'GBP',
      [t.openBooked.id]: 'EUR',
      [t.completed.id]: 'EUR',
      [t.cancelled.id]: 'EUR',
      [t.studioYesterday.id]: 'EUR',
      [t.studioTomorrow.id]: 'GBP',
    });
    expect(
      (await prisma.teacher.findUniqueOrThrow({ where: { id: t.f.teacherId }, select: { currency: true } })).currency,
    ).toBe('GBP');
  });

  it('answers unchanged for the stored currency and writes nothing', async () => {
    const f = await utcTeacher();
    const cls = await classAt(f, 10);
    const before = await prisma.teacher.findUniqueOrThrow({ where: { id: f.teacherId } });

    const result = await prisma.$transaction((tx) => switchTeacherCurrency(tx, f.teacherId, 'EUR'));

    expect(result).toBe('unchanged');
    expect(await prisma.teacher.findUniqueOrThrow({ where: { id: f.teacherId } })).toEqual(before);
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, select: { updatedAt: true } })).updatedAt,
    ).toEqual(cls.updatedAt);
  });

  it('answers teacher_gone for an erased teacher and writes nothing', async () => {
    const f = await utcTeacher();
    const cls = await classAt(f, 10);
    await prisma.teacher.update({ where: { id: f.teacherId }, data: { deletedAt: new Date() } });

    const result = await prisma.$transaction((tx) => switchTeacherCurrency(tx, f.teacherId, 'GBP'));

    expect(result).toBe('teacher_gone');
    expect(
      (await prisma.teacher.findUniqueOrThrow({ where: { id: f.teacherId }, select: { currency: true } })).currency,
    ).toBe('EUR');
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, select: { currency: true } })).currency,
    ).toBe('EUR');
  });

  // The cross-owner decoy (`docs/superpowers/specs/2026-09-05-pre-lock-scope-decoys-design.md`):
  // rows the owner conjuncts exclude and a widened predicate would reach.
  it("leaves another teacher's classes, studio classes and currency untouched", async () => {
    const subject = await utcTeacher();
    const subjectClass = await classAt(subject, 10);
    const bystander = await utcTeacher();
    const bystanderClass = await classAt(bystander, 10);
    const bystanderStudio = await studioAt(bystander, 2);

    await prisma.$transaction((tx) => switchTeacherCurrency(tx, subject.teacherId, 'GBP'));

    expect(
      await currencies({ classes: [subjectClass.id, bystanderClass.id], studio: [bystanderStudio.id] }),
    ).toEqual({
      [subjectClass.id]: 'GBP',
      [bystanderClass.id]: 'EUR',
      [bystanderStudio.id]: 'EUR',
    });
    expect(
      (await prisma.teacher.findUniqueOrThrow({ where: { id: bystander.teacherId }, select: { currency: true } })).currency,
    ).toBe('EUR');
  });
});

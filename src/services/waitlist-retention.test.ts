import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ClassStatus, WaitlistStatus } from '@prisma/client';
import {
  reapClosedWaitlistEntries,
  retentionCutoff,
  WAITLIST_RETENTION_DAYS,
} from './waitlist-retention';

/**
 * A pure DB-invariant suite — nothing here calls the app on `:3000` — so it
 * lives in the `unit` project, where `tests/setup/unit-db.ts` forces it onto
 * `DATABASE_URL_TEST`. The same reasoning `class-terminal-status.test.ts`'s
 * header sets out: an `integration` file would run against the DEV database by
 * design (`docs/test-database.md` §3.4), and this file DELETES rows.
 */
const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/** Fixed "today" so every date below is computed, not guessed. */
const NOW = new Date('2026-08-16T12:00:00.000Z');
const CUTOFF = retentionCutoff(NOW);

/** A UTC-midnight date `days` before the cutoff. Negative = after it. */
function daysBeforeCutoff(days: number): Date {
  const d = new Date(CUTOFF);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
let studentId: string;
const classIds: string[] = [];

/**
 * Distinct `startTime` per class. `Class_teacher_slot_unique` compares
 * (teacherId, date, startTime) as strings, and several classes here share a
 * date. Routed through a wrapping helper rather than a raw `09:${counter}`
 * literal, which would emit `09:60` once the counter crosses 60 — the same
 * trap `class-terminal-status.test.ts`'s `slotTime` documents.
 */
let slotCounter = 0;
function slotTime(): string {
  slotCounter += 1;
  const hour = 9 + Math.floor(slotCounter / 60);
  const minute = slotCounter % 60;
  const startTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (!/^\d{2}:[0-5]\d$/.test(startTime)) {
    throw new Error(`slotTime produced an invalid startTime: ${startTime}`);
  }
  return startTime;
}

/**
 * One class in a given status on a given date, with one waitlist entry on it.
 *
 * One entry per class, never two: `@@unique([classId, studentId])` allows only
 * one entry per student per class, and every case here uses the same student.
 * Distinct classes is also what makes the sweep's per-class loop observable.
 */
async function makeClassWithEntry(opts: {
  classStatus: ClassStatus;
  date: Date;
  entryStatus: WaitlistStatus;
  withRegistration?: boolean;
  id?: string;
}): Promise<{ classId: string; entryId: string }> {
  const cls = await prisma.class.create({
    data: {
      ...(opts.id ? { id: opts.id } : {}),
      teacherId,
      teacherRoomId,
      classType: 'Retention Test',
      date: opts.date,
      startTime: slotTime(),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 8,
      status: opts.classStatus,
    },
  });
  classIds.push(cls.id);

  let registrationId: string | null = null;
  if (opts.withRegistration) {
    const reg = await prisma.registration.create({
      data: { classId: cls.id, studentId, tierAtBooking: 3 },
    });
    registrationId = reg.id;
  }

  const entry = await prisma.waitlistEntry.create({
    data: {
      classId: cls.id,
      studentId,
      position: 1,
      status: opts.entryStatus,
      ...(registrationId ? { registrationId } : {}),
    },
  });
  return { classId: cls.id, entryId: entry.id };
}

async function entryExists(entryId: string): Promise<boolean> {
  return (await prisma.waitlistEntry.count({ where: { id: entryId } })) === 1;
}

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Retention',
      lastName: 'Sweep',
      email: `retention-${uniqueSuffix}@test.local`,
      account: { create: { email: `retention-${uniqueSuffix}@test.local` } },
      bio: 'Waitlist retention tests',
      pageSlug: `retention-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Retention Studio',
      address: `${uniqueSuffix} Sweep St`,
      city: 'Amsterdam',
      postcode: '1234RA',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacherId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  teacherRoomId = teacherRoom.id;

  const student = await prisma.student.create({
    data: {
      firstName: 'Retention',
      lastName: 'Student',
      email: `retention-student-${uniqueSuffix}@test.local`,
      incomeTier: 3,
    },
  });
  studentId = student.id;
});

afterAll(async () => {
  // Ordered children-first. #177 is about test databases accumulating rows
  // nothing prunes; a retention suite that leaks its own fixtures would be a
  // poor joke.
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.payment.deleteMany({ where: { registration: { classId: { in: classIds } } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('retentionCutoff', () => {
  it('is the UTC midnight of today minus the retention window, whatever hour it is called at', () => {
    // Both times of day must land on the same date, or the sweep's behaviour
    // depends on the hour the scheduler happens to tick — the exact shape of
    // trap `prisma/seed.ts` carries a standing warning about.
    const morning = retentionCutoff(new Date('2026-08-16T00:30:00.000Z'));
    const evening = retentionCutoff(new Date('2026-08-16T23:30:00.000Z'));

    expect(morning.toISOString()).toBe('2025-08-16T00:00:00.000Z');
    expect(evening.toISOString()).toBe(morning.toISOString());
    expect(WAITLIST_RETENTION_DAYS).toBe(365);
  });
});

describe('reapClosedWaitlistEntries', () => {
  it('deletes an unfulfilled entry on a terminal class past the window', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    const summary = await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(summary.deleted).toBeGreaterThanOrEqual(1);
    expect(await entryExists(entryId)).toBe(false);
  });

  it('keeps an entry that became a registration, however old the class', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(400),
      entryStatus: 'claimed',
      withRegistration: true,
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(true);
  });

  /**
   * The belt-and-braces clause, and the reason it is testable at all.
   *
   * No production writer can make this row: all three fulfilment sites write
   * `registrationId` in the same statement as the status. A fixture can, and
   * that is enough — the clause exists because deleting is irreversible and the
   * two discriminators are derived independently, so their intersection is the
   * conservative one. Drop `status: { notIn: FULFILLED }` from the predicate
   * and this test goes red, which is the whole point: a guard that cannot fail
   * certifies nothing.
   */
  it('keeps a promoted entry whose registrationId is somehow null', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(400),
      entryStatus: 'promoted',
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(true);
  });

  it.each<ClassStatus>(['draft', 'open', 'in_progress'])(
    'keeps an entry on a %s class, which is not terminal',
    async (classStatus) => {
      const { entryId } = await makeClassWithEntry({
        classStatus,
        date: daysBeforeCutoff(400),
        entryStatus: 'waiting',
      });

      await reapClosedWaitlistEntries(prisma, { now: NOW });

      expect(await entryExists(entryId)).toBe(true);
    },
  );

  /**
   * All three unfulfilled statuses, not just the common one. `waiting` on a
   * terminal class is the pre-#216 legacy population this sweep exists to
   * finish off; `expired` is what `closeQueueOnStart` writes when a class
   * starts; `removed` is what the three cancel paths write.
   */
  it.each<WaitlistStatus>(['waiting', 'expired', 'removed'])(
    'deletes a %s entry on a terminal class past the window',
    async (entryStatus) => {
      const { entryId } = await makeClassWithEntry({
        classStatus: 'cancelled',
        date: daysBeforeCutoff(1),
        entryStatus,
      });

      await reapClosedWaitlistEntries(prisma, { now: NOW });

      expect(await entryExists(entryId)).toBe(false);
    },
  );

  it('keeps an entry on a class dated exactly at the cutoff', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(0),
      entryStatus: 'expired',
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(true);
  });

  it('deletes an entry on a class dated one day before the cutoff', async () => {
    const { entryId } = await makeClassWithEntry({
      classStatus: 'completed',
      date: daysBeforeCutoff(1),
      entryStatus: 'expired',
    });

    await reapClosedWaitlistEntries(prisma, { now: NOW });

    expect(await entryExists(entryId)).toBe(false);
  });
});

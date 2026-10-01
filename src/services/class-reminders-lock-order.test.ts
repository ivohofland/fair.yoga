/**
 * @serial-tier lock-contention — holds a `Class` row `FOR UPDATE` on a second
 * connection across a staged wait while a reminder claim queues behind it,
 * and probes the claim's `Registration` row with `NOWAIT` while it waits; lock
 * noise from a neighbour in the parallel tier would land on that probe.
 *
 * The order this pins is `docs/lock-order.md`'s line, `Class` before
 * `Registration`, for the student claim in `processClassReminders`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { processClassReminders } from './class-reminders';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import { scopeSweep } from '../../tests/scoped-sweep';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];
const roomIds: string[] = [];
const classIds: string[] = [];
const studentIds: string[] = [];

const MORNING = new Date('2099-06-10T07:00:00Z');
const WAIT_MS = 1_500;

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/** `'free'` when nothing holds the registration row, else the probe's error. */
async function probeRegistration(registrationId: string): Promise<string> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE NOWAIT`;
    });
    return 'free';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function seed() {
  const s = uniqueSuffix();
  const email = `classrem-lock-${s}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Lock', lastName: 'Reminder', email, account: { create: { email } },
      bio: '', pageSlug: `classrem-lock-${s}`, defaultTimezone: 'UTC', classReminder: 'off',
    },
  });
  teacherIds.push(teacher.id);
  if (teacher.accountId !== null) accountIds.push(teacher.accountId);
  const room = await prisma.room.create({
    data: {
      venueName: 'ClassRem Lock Studio', address: `${s} Lock St`, city: 'Amsterdam',
      postcode: '1234CL', maxCapacity: 20, createdById: teacher.id,
    },
  });
  roomIds.push(room.id);
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
  });
  const cls = await createClassFixture(prisma, {
    teacherId: teacher.id, teacherRoomId: teacherRoom.id, classType: 'Flow',
    date: new Date('2099-06-10'), startTime: hhmmToTime('18:00'), durationMinutes: 60,
    roomCost: 20, minRate: 15, targetRate: 25, minStudents: 1, maxStudents: 12, status: 'open',
  });
  classIds.push(cls.id);
  const student = await prisma.student.create({
    data: {
      firstName: 'Lock', lastName: 'Student', email: `classrem-lock-student-${s}@test.local`,
      incomeTier: 3, classReminder: 'morning_of', classReminderChannel: 'inbox',
    },
  });
  studentIds.push(student.id);
  const registration = await prisma.registration.create({
    data: {
      classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 3,
      registeredAt: new Date('2099-06-01T00:00:00Z'),
    },
  });
  return { teacherId: teacher.id, classId: cls.id, studentId: student.id, registrationId: registration.id };
}

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('the student reminder claim takes Class before Registration', () => {
  it('queues behind a held class without having locked the registration', async () => {
    const f = await seed();
    const holder = new PrismaClient();
    const held = latch(); const release = latch();
    let holderPid = 0;
    // What an erasure holds before it updates the class's registrations.
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${f.classId} FOR UPDATE`;
      held.open();
      await release.promise;
    }, { timeout: 10_000 });
    let sweep: Promise<unknown> | undefined;
    try {
      await Promise.race([held.promise, holding]);
      let settled = false;
      const running = processClassReminders(
        scopeSweep(prisma, { Class: { calendarEntry: { teacherId: f.teacherId } } }).db,
        MORNING,
      ).finally(() => { settled = true; });
      sweep = running;
      void running.catch(() => undefined);

      expect(await waiterOf(holderPid, () => settled)).not.toBeNull(); // the claim is parked on the class
      // Parked before its registration update: an erasure holding the class
      // can still take the registration, so the two cannot form a cycle.
      expect(await probeRegistration(f.registrationId)).toBe('free');

      release.open();
      await holding;
      expect(await running).toMatchObject({ studentReminders: 1 });
      expect(await prisma.notification.count({
        where: { recipientType: 'student', recipientId: f.studentId, type: 'class_reminder' },
      })).toBe(1);
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await sweep?.catch(() => undefined);
      await holder.$disconnect();
    }
  }, 20_000);
});

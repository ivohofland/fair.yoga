/**
 * @serial-tier lock-contention — each case holds a row lock and asserts, via
 * `pg_blocking_pids`, that the transactions it stages parked behind it: a
 * bank-account save's `FOR NO KEY UPDATE` on a teacher with `resumePayments`
 * waiting on the same row, and a held `Class` row with a student erasure
 * waiting on it and a resume waiting on the erasure. Lock noise from a
 * neighbour in the parallel tier would stretch those waits past the window
 * the assertions allow, and the second case must release its holder inside
 * the erasure's `lock_timeout`.
 *
 * A resume reads the payout details it fingerprints under the payout
 * writers' own lock, so a save in flight finishes first and the resume sees
 * what it wrote. A resume beside a student erasure takes the classes the two
 * share in the erasure's direction, so the two queue rather than deadlock.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { payoutFingerprint } from '@/lib/payout-fingerprint';
import { bankAccountDataSelect } from '@/lib/payment-methods';
import { hhmmToTime } from '@/lib/time-of-day';
import { resumePayments, type ResumeOutcome } from './payout-resume';
import { deleteStudentAccount } from './gdpr';
import { uniqueSuffix } from '../../tests/helpers';
import { createClassFixture } from '../../tests/class-fixtures';
import { expectErased } from '../../tests/erasure-assertions';
import { joinOrThrow } from '../../tests/lock-order-teardown';

const prisma = new PrismaClient();
const WAIT_MS = 1_500;
const teacherIds: string[] = [];
const accountIds: string[] = [];

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

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

describe('resumePayments behind a bank-account save in flight', () => {
  it('parks on the teacher row, then refuses the details the save changed', async () => {
    const s = uniqueSuffix();
    const email = `resume-lock-${s}@test.local`;
    const now = new Date();
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Resume', lastName: 'Lock', email, bio: '', pageSlug: `resume-lock-${s}`,
        account: { create: { email } },
        paymentsPausedAt: new Date(now.getTime() - 60_000), pauseWindowStart: new Date(now.getTime() - 120_000),
        bankAccounts: { create: { currency: 'EUR', holderName: 'Anna', iban: 'NL91ABNA0417164300' } },
      },
      select: { id: true, accountId: true, paymentLink: true, bankAccounts: { select: bankAccountDataSelect } },
    });
    teacherIds.push(t.id);
    accountIds.push(t.accountId);
    const sessionId = hashToken(crypto.randomBytes(32).toString('hex'));
    await prisma.session.create({ data: { id: sessionId, accountId: t.accountId, expiresAt: new Date(now.getTime() + 86_400_000) } });
    const shown = payoutFingerprint(t);

    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${t.id} FOR NO KEY UPDATE`;
      await tx.teacherBankAccount.update({
        where: { teacherId_currency: { teacherId: t.id, currency: 'EUR' } },
        data: { iban: 'NL02ABNA0123456789' },
      });
      held.open();
      await release.promise;
    }, { timeout: 20_000 });

    let outcome: ResumeOutcome | null = null;
    let parked = false;
    try {
      await held.promise;
      let settled = false;
      const pending = resumePayments(prisma, { teacherId: t.id, sessionId, fingerprint: shown, now })
        .finally(() => { settled = true; });
      void pending.catch(() => undefined);
      parked = (await waiterOf(holderPid, () => settled)) !== null;
      release.open();
      await holding;
      outcome = await pending;
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await holder.$disconnect();
    }

    expect(parked).toBe(true);
    expect(outcome).toEqual({ status: 'details_changed' });
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: t.id }, select: { paymentsPausedAt: true } });
    expect(state.paymentsPausedAt).not.toBeNull();
  }, 20_000);
});

describe('resumePayments against a student erasure on two completed classes', () => {
  let teacherId = '';
  let teacherAccountId = '';
  let roomId = '';
  let studentId = '';
  let studentAccountId = '';

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: studentId } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: [teacherAccountId, studentAccountId] } } });
  });

  // The erasure locks both classes `FOR UPDATE` in ascending id; the resume's
  // reminders take `FOR KEY SHARE` on the same two through their
  // `relatedClassId` foreign key. C holds the higher class so the erasure
  // stops between its two locks, holding the lower; the resume then starts and
  // parks behind it. Released, the two must queue rather than close a cycle.
  it('queues behind the erasure instead of deadlocking on the classes they share', async () => {
    const s = uniqueSuffix();
    const email = `resume-erase-${s}@test.local`;
    const now = new Date();
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Resume', lastName: 'Erase', email, bio: '', pageSlug: `resume-erase-${s}`,
        account: { create: { email } },
        paymentsPausedAt: new Date(now.getTime() - 60_000), pauseWindowStart: new Date(now.getTime() - 120_000),
        bankAccounts: { create: { currency: 'EUR', holderName: 'Anna', iban: 'NL91ABNA0417164300' } },
      },
      select: { id: true, accountId: true, paymentLink: true, bankAccounts: { select: bankAccountDataSelect } },
    });
    teacherId = t.id;
    teacherAccountId = t.accountId;
    const sessionId = hashToken(crypto.randomBytes(32).toString('hex'));
    await prisma.session.create({ data: { id: sessionId, accountId: t.accountId, expiresAt: new Date(now.getTime() + 86_400_000) } });
    const shown = payoutFingerprint(t);

    const room = await prisma.room.create({
      data: {
        venueName: 'Resume Studio', address: `${s} St`, city: 'Amsterdam', postcode: '1234RE',
        floor: '1', roomName: 'Main', maxCapacity: 20, createdById: t.id,
      },
      select: { id: true },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: t.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const studentEmail = `resume-erase-${s}-student@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Erased', lastName: 'Student', email: studentEmail, incomeTier: 2, claimedAt: now,
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    if (student.accountId === null) throw new Error('the student was created without its account');
    studentAccountId = student.accountId;

    const classIds: string[] = [];
    for (const date of [new Date('2026-01-05'), new Date('2026-01-06')]) {
      const cls = await createClassFixture(prisma, {
        teacherId: t.id,
        teacherRoomId: teacherRoom.id,
        classType: 'Resume class',
        date,
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'completed',
      });
      classIds.push(cls.id);
      const registration = await prisma.registration.create({
        data: { classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 2, price: 20 },
        select: { id: true },
      });
      await prisma.payment.create({ data: { registrationId: registration.id, amount: 20, status: 'pending' } });
      await prisma.waitlistEntry.create({
        data: {
          classId: cls.id, studentId: student.id, position: 1, status: 'claimed',
          promotedAt: now, registrationId: registration.id,
        },
      });
    }

    // Postgres's order, not a JS string comparison: the erasure's `ORDER BY`
    // is the one being met.
    const ordered = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Class" WHERE id IN (${Prisma.join(classIds)}) ORDER BY id`;
    const hi = ordered[1]?.id;
    if (hi === undefined) throw new Error('the two classes did not come back');

    const holder = new PrismaClient();
    const resumer = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    // `FOR NO KEY UPDATE` conflicts with the erasure's `FOR UPDATE` and not
    // with the resume's `FOR KEY SHARE`.
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${hi} FOR NO KEY UPDATE`;
      held.open();
      await release.promise;
    }, { timeout: 20_000 });

    let erasing: Promise<void> | undefined;
    let resuming: Promise<ResumeOutcome> | undefined;
    let erasurePid: number | null = null;
    let resumePid: number | null = null;
    let outcome: ResumeOutcome | null = null;
    try {
      await held.promise;
      let erasureSettled = false;
      erasing = expectErased(deleteStudentAccount(prisma, student.id)).finally(() => { erasureSettled = true; });
      void erasing.catch(() => undefined);
      erasurePid = await waiterOf(holderPid, () => erasureSettled);
      if (erasurePid === null) throw new Error('the erasure never parked behind the held class');

      let resumeSettled = false;
      resuming = resumePayments(resumer, { teacherId: t.id, sessionId, fingerprint: shown, now })
        .finally(() => { resumeSettled = true; });
      void resuming.catch(() => undefined);
      resumePid = await waiterOf(erasurePid, () => resumeSettled);

      release.open();
      await holding;
      await erasing;
      outcome = await resuming;
    } finally {
      release.open();
      try {
        await joinOrThrow(holding, erasing, resuming);
      } finally {
        await holder.$disconnect();
        await resumer.$disconnect();
      }
    }

    expect(erasurePid).not.toBeNull();
    expect(resumePid).not.toBeNull();
    expect(outcome).toEqual({ status: 'resumed' });
  }, 20_000);
});

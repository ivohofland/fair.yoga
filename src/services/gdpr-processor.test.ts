/**
 * What Mollie Connect adds to export and erasure: a student's export lists
 * each payment's attempts and refunds, a teacher's lists the connection (never
 * a token), a teacher's erasure deletes the connection and revokes its grant
 * after commit, and a student's erasure scrubs the teacher notifications that
 * carry their first name.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@/lib/degradation', () => ({ logDegraded: vi.fn() }));

import { Prisma, createPrismaClient } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { MollieUnavailable, type MollieClient } from '@/lib/mollie/client';
import { MOLLIE_SCOPES } from '@/lib/processor-liveness';
import { logDegraded } from '@/lib/degradation';
import { log } from '@/lib/log';
import { createClassFixture } from '../../tests/class-fixtures';
import { expectErased } from '../../tests/erasure-assertions';
import { uniqueSuffix } from '../../tests/helpers';
import { deleteStudentAccount, deleteTeacherAccount, exportStudentData, exportTeacherData } from './gdpr';
import { sealGrant } from './processor-token';
import type { MollieDeps } from './mollie-deps';

const prisma = createPrismaClient();
const key = randomBytes(32);
const PROFILE = 'pfl_one11111';
const ORG = 'org_aaaa1111';

type Fake = { [K in keyof MollieClient]: ReturnType<typeof vi.fn> };
const fake: Fake = {
  authorizeUrl: vi.fn(),
  exchangeCode: vi.fn(),
  refresh: vi.fn(),
  revoke: vi.fn(),
  organization: vi.fn(),
  profiles: vi.fn(),
  listMethods: vi.fn(),
  createPayment: vi.fn(),
  getPayment: vi.fn(),
  createRefund: vi.fn(),
};
const deps: MollieDeps = {
  client: fake as unknown as MollieClient,
  config: { clientId: 'app_client', clientSecret: 'secret', tokenKey: key, testmode: false, appUrl: 'https://fair.yoga' },
};

const teacherIds: string[] = [];
const studentIds: string[] = [];
const roomIds: string[] = [];
const accountIds: string[] = [];
let seededDays = 0;

type World = {
  teacherId: string;
  studentId: string;
  classId: string;
  paymentId: string;
  connectionId: string;
  attemptId: string;
  mollieIds: { payment: string; refund: string };
};

/** A teacher with a live connection, and one student who owes a payment on a completed class, paid through Mollie and refunded. */
async function world(opts: { refreshKey?: Buffer } = {}): Promise<World> {
  const s = uniqueSuffix();
  const teacherEmail = `gdpr-proc-t-${s}@test.local`;
  const teacher = await prisma.teacher.create({
    data: { firstName: 'Tea', lastName: 'Cher', email: teacherEmail, bio: '', pageSlug: `gdpr-proc-${s}`, account: { create: { email: teacherEmail } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(teacher.id);
  accountIds.push(teacher.accountId);
  const studentEmail = `gdpr-proc-s-${s}@test.local`;
  const student = await prisma.student.create({
    data: { firstName: 'Zelda', lastName: 'Learner', email: studentEmail, claimedAt: new Date(), account: { create: { email: studentEmail } } },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  accountIds.push(student.accountId as string);
  await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });
  const room = await prisma.room.create({
    data: { venueName: 'Proc Studio', address: `${s} St`, city: 'Amsterdam', postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: teacher.id },
  });
  roomIds.push(room.id);
  const teacherRoom = await prisma.teacherRoom.create({ data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 25 } });
  const cls = await createClassFixture(prisma, {
    teacherId: teacher.id, teacherRoomId: teacherRoom.id, classType: `Proc ${s}`, date: new Date(Date.UTC(2026, 5, 1 + seededDays++)),
    startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: 20, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 10,
    status: 'completed', effectiveTeacherRate: 10, totalStudents: 1, totalRevenue: 30, vatTotal: 0,
  });
  const registration = await prisma.registration.create({ data: { classId: cls.id, studentId: student.id, status: 'attended', tierAtBooking: 3 } });
  const payment = await prisma.payment.create({ data: { registrationId: registration.id, amount: 10, status: 'pending' } });
  const connection = await prisma.processorConnection.create({
    data: {
      teacherId: teacher.id, processor: 'mollie', organizationId: ORG, profileId: PROFILE, scopes: [...MOLLIE_SCOPES], testmode: false,
      ...sealGrant({ accessToken: 'access_live', refreshToken: 'refresh_live', expiresInSeconds: 3600, scopes: [...MOLLIE_SCOPES] }, opts.refreshKey ?? key, new Date()),
    },
    select: { id: true },
  });
  const mollieIds = { payment: `tr_${s}`.replace(/-/g, ''), refund: `re_${s}`.replace(/-/g, '') };
  const paidAt = new Date('2026-06-02T10:00:00Z');
  const attempt = await prisma.processorPayment.create({
    data: {
      paymentId: payment.id, connectionId: connection.id, processorPaymentId: mollieIds.payment, profileId: PROFILE, testmode: false,
      method: 'ideal', status: 'paid', amount: new Prisma.Decimal('10.00'), currency: 'EUR', paidAt,
    },
    select: { id: true },
  });
  await prisma.processorRefund.create({
    data: { attemptId: attempt.id, processorRefundId: mollieIds.refund, amount: new Prisma.Decimal('10.00'), status: 'refunded', outcome: 'waived' },
  });
  return { teacherId: teacher.id, studentId: student.id, classId: cls.id, paymentId: payment.id, connectionId: connection.id, attemptId: attempt.id, mollieIds };
}

beforeEach(() => {
  for (const fn of Object.values(fake)) fn.mockReset();
  vi.mocked(logDegraded).mockClear();
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { recipientId: { in: [...teacherIds, ...studentIds] } } });
  await prisma.payment.deleteMany({ where: { registration: { studentId: { in: studentIds } } } });
  await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('student export', () => {
  it('lists each payment’s attempts and their refunds, and none of Mollie’s identifiers', async () => {
    const w = await world();
    const exported = await exportStudentData(prisma, w.studentId);
    const payment = exported.bookings[0]?.payment;
    expect(payment?.processorAttempts).toEqual([
      {
        method: 'ideal', status: 'paid', amount: new Prisma.Decimal('10.00'), currency: 'EUR', paidAt: new Date('2026-06-02T10:00:00Z'),
        refunds: [{ amount: new Prisma.Decimal('10.00'), status: 'refunded', requestedAt: expect.any(Date) as Date }],
      },
    ]);
    const text = JSON.stringify(exported);
    for (const secret of [w.mollieIds.payment, w.mollieIds.refund, PROFILE, ORG, w.connectionId, w.attemptId]) {
      expect(text).not.toContain(secret);
    }
  });

  it('lists an empty attempt list for a payment nobody paid through Mollie', async () => {
    const w = await world();
    await prisma.processorPayment.deleteMany({ where: { paymentId: w.paymentId } });
    const exported = await exportStudentData(prisma, w.studentId);
    expect(exported.bookings[0]?.payment?.processorAttempts).toEqual([]);
  });
});

describe('teacher export', () => {
  it('lists the connection by its identity and dates, and carries no token', async () => {
    const w = await world();
    const row = await prisma.processorConnection.findUniqueOrThrow({ where: { id: w.connectionId } });
    const exported = await exportTeacherData(prisma, w.teacherId);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object' || v instanceof Date || v instanceof Prisma.Decimal) return;
      for (const [k, child] of Object.entries(v)) {
        keys.push(k);
        walk(child);
      }
    };
    walk(exported);
    expect(keys.filter((k) => /token/i.test(k))).toEqual([]);
    expect(exported.processorConnection).toEqual({
      processor: 'mollie', organizationId: ORG, profileId: PROFILE, testmode: false, connectedAt: row.connectedAt, disconnectedAt: null,
    });
    expect(JSON.stringify(exported)).not.toMatch(/refresh_live|access_live/);
  });

  it('exports null for a teacher who never connected', async () => {
    const w = await world();
    await prisma.processorConnection.delete({ where: { id: w.connectionId } });
    expect((await exportTeacherData(prisma, w.teacherId)).processorConnection).toBeNull();
  });
});

describe('teacher erasure', () => {
  it('deletes the connection, keeps attempts and refunds with their payment, and revokes the grant after commit', async () => {
    const w = await world();
    fake.revoke.mockResolvedValue(undefined);
    await expectErased(deleteTeacherAccount(prisma, w.teacherId, deps));
    expect(await prisma.processorConnection.count({ where: { teacherId: w.teacherId } })).toBe(0);
    const attempt = await prisma.processorPayment.findUniqueOrThrow({ where: { id: w.attemptId }, include: { refunds: true } });
    expect(attempt.connectionId).toBeNull();
    expect(attempt.paymentId).toBe(w.paymentId);
    expect(attempt.refunds).toHaveLength(1);
    await vi.waitFor(() => expect(fake.revoke).toHaveBeenCalledWith('refresh_live'));
    expect(fake.revoke).toHaveBeenCalledTimes(1);
  });

  it('still erases, and logs, when Mollie cannot revoke', async () => {
    const w = await world();
    fake.revoke.mockRejectedValue(new MollieUnavailable('down', 503));
    await expectErased(deleteTeacherAccount(prisma, w.teacherId, deps));
    expect(await prisma.processorConnection.count({ where: { teacherId: w.teacherId } })).toBe(0);
    await vi.waitFor(() => expect(vi.mocked(logDegraded).mock.calls.map(([code]) => code)).toContain('MOLLIE_UNAVAILABLE'));
  });

  it('skips the revoke and logs when the stored token cannot be opened, and still deletes the row', async () => {
    const w = await world({ refreshKey: randomBytes(32) });
    await expectErased(deleteTeacherAccount(prisma, w.teacherId, deps));
    expect(await prisma.processorConnection.count({ where: { teacherId: w.teacherId } })).toBe(0);
    expect(fake.revoke).not.toHaveBeenCalled();
    expect(vi.mocked(logDegraded).mock.calls.map(([code, , message]) => [code, message])).toContainEqual([
      'PROCESSOR_TOKEN_UNREADABLE',
      expect.stringContaining('erased teacher'),
    ]);
  });

  it('deletes the row, calls Mollie for nothing and records the grant it left when Mollie is not configured', async () => {
    const w = await world();
    const warn = vi.spyOn(log, 'warn');
    try {
      await expectErased(deleteTeacherAccount(prisma, w.teacherId, null));
      expect(await prisma.processorConnection.count({ where: { teacherId: w.teacherId } })).toBe(0);
      expect(fake.revoke).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith({ connectionId: w.connectionId }, expect.stringContaining('stays authorized at Mollie'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not revoke a grant that was already revoked, and deletes its row', async () => {
    const w = await world();
    await prisma.processorConnection.update({
      where: { id: w.connectionId },
      data: { accessToken: null, refreshToken: null, accessTokenExpiresAt: null, disconnectedAt: new Date(), revokeAfter: new Date(), revokedAt: new Date() },
    });
    await expectErased(deleteTeacherAccount(prisma, w.teacherId, deps));
    expect(await prisma.processorConnection.count({ where: { teacherId: w.teacherId } })).toBe(0);
    expect(fake.revoke).not.toHaveBeenCalled();
  });

  it('deletes the teacher’s pending OAuth sign-in states, even when a student profile keeps the session alive', async () => {
    const w = await world();
    const account = await prisma.teacher.findUniqueOrThrow({ where: { id: w.teacherId }, select: { accountId: true, email: true } });
    const dual = await prisma.student.create({
      data: { firstName: 'Dual', lastName: 'Hat', email: `dual-${account.email}`, claimedAt: new Date(), accountId: account.accountId },
      select: { id: true },
    });
    studentIds.push(dual.id);
    const sessionId = randomBytes(32).toString('hex');
    await prisma.session.create({ data: { id: sessionId, accountId: account.accountId, expiresAt: new Date(Date.now() + 86_400_000) } });
    await prisma.oAuthState.create({ data: { stateHash: randomBytes(32).toString('hex'), teacherId: w.teacherId, sessionId, expiresAt: new Date(Date.now() + 600_000) } });
    await expectErased(deleteTeacherAccount(prisma, w.teacherId, null));
    expect(await prisma.session.count({ where: { id: sessionId } })).toBe(1);
    expect(await prisma.oAuthState.count({ where: { teacherId: w.teacherId } })).toBe(0);
  });
});

describe('student erasure scrubs the teacher notifications that name the student', () => {
  const bodyOf = async (id: string) => (await prisma.notification.findUniqueOrThrow({ where: { id }, select: { body: true } })).body;

  it('rewrites a paid-twice and a charged-back body, and leaves another student’s and other types alone', async () => {
    const w = await world();
    const mk = (type: 'payment_paid_twice' | 'payment_charged_back' | 'refund_failed', body: string) =>
      prisma.notification.create({
        data: { recipientType: 'teacher', recipientId: w.teacherId, type, title: 'T', body, relatedClassId: w.classId },
        select: { id: true },
      });
    const twice = await mk('payment_paid_twice', 'Zelda also paid €10.00 by iDEAL. You can refund it from the payment.');
    const back = await mk('payment_charged_back', 'Zelda disputed €10.00 with their bank and it was taken back. You can mark the payment unpaid to ask again.');
    const other = await mk('payment_paid_twice', 'Someone Else also paid €10.00 by iDEAL. You can refund it from the payment.');
    const failed = await mk('refund_failed', 'A refund didn’t go through. Check your Mollie balance and try again from the payment.');

    await expectErased(deleteStudentAccount(prisma, w.studentId));

    for (const id of [twice.id, back.id]) {
      const body = await bodyOf(id);
      expect(body).not.toContain('Zelda');
      expect(body).toMatch(/^A student \(account since deleted\)/);
    }
    expect(await bodyOf(other.id)).toBe('Someone Else also paid €10.00 by iDEAL. You can refund it from the payment.');
    expect(await bodyOf(failed.id)).toBe('A refund didn’t go through. Check your Mollie balance and try again from the payment.');
  });
});

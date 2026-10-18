/**
 * The hand-written objects of the `mollie_connect` migration, against a real
 * database: the connection's token checks and the two partial unique indexes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Prisma, createPrismaClient } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { uniqueSuffix } from '../../tests/helpers';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const sealed = Buffer.from([1, 2, 3]);
const teacherIds: string[] = [];
const accountIds: string[] = [];
const roomIds: string[] = [];
let studentId = '';
let teacherA = '';
let teacherB = '';
let teacherC = '';
let paymentId = '';
let connectionId = '';
let attemptId = '';

async function makeTeacher(key: string): Promise<string> {
  const email = `proc-schema-${key}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: { firstName: 'Proc', lastName: key, email, bio: '', pageSlug: `proc-schema-${key}-${suffix}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(teacher.id);
  accountIds.push(teacher.accountId);
  return teacher.id;
}

async function connection(teacherId: string, data: Partial<Prisma.ProcessorConnectionUncheckedCreateInput> = {}) {
  return prisma.processorConnection.create({
    data: {
      teacherId,
      processor: 'mollie',
      organizationId: 'org_test',
      profileId: 'pfl_test',
      accessToken: sealed,
      refreshToken: sealed,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      scopes: ['payments.read'],
      testmode: true,
      ...data,
    },
  });
}

async function expectCheck(promise: Promise<unknown>, constraint: string) {
  await expect(promise).rejects.toThrow(constraint);
}

beforeAll(async () => {
  teacherA = await makeTeacher('a');
  teacherB = await makeTeacher('b');
  teacherC = await makeTeacher('c');
  const owner = await makeTeacher('owner');

  const studentEmail = `proc-schema-student-${suffix}@test.local`;
  const student = await prisma.student.create({
    data: { firstName: 'Stu', lastName: 'Dent', email: studentEmail, claimedAt: new Date(), account: { create: { email: studentEmail } } },
    select: { id: true, accountId: true },
  });
  studentId = student.id;
  accountIds.push(student.accountId as string);

  const room = await prisma.room.create({
    data: { venueName: 'Proc Studio', address: `${suffix} St`, city: 'Amsterdam', postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: owner },
  });
  roomIds.push(room.id);
  const teacherRoom = await prisma.teacherRoom.create({ data: { teacherId: owner, roomId: room.id, capacityOverride: 15, rentalRate: 25 } });
  const cls = await createClassFixture(prisma, {
    teacherId: owner,
    teacherRoomId: teacherRoom.id,
    classType: `Proc ${suffix}`,
    date: new Date('2026-06-08T00:00:00.000Z'),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 10,
    targetRate: 20,
    minStudents: 1,
    maxStudents: 10,
    status: 'completed',
    effectiveTeacherRate: 10,
    totalStudents: 4,
    totalRevenue: 30,
    vatTotal: 0,
  });
  const registration = await prisma.registration.create({
    data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 },
  });
  const payment = await prisma.payment.create({
    data: { registrationId: registration.id, amount: 10, status: 'pending' },
  });
  paymentId = payment.id;
  connectionId = (await connection(owner)).id;
  attemptId = (
    await prisma.processorPayment.create({
      data: {
        paymentId,
        connectionId,
        processorPaymentId: `tr_seed${suffix}`,
        method: 'ideal',
        status: 'open',
        amount: new Prisma.Decimal('10.00'),
        currency: 'EUR',
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { registration: { studentId } } });
  await prisma.registration.deleteMany({ where: { studentId } });
  await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  await prisma.student.deleteMany({ where: { id: studentId } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('ProcessorConnection constraints', () => {
  it('refuses a row without tokens that is not revoked', async () => {
    await expectCheck(connection(teacherA, { accessToken: null }), 'ProcessorConnection_tokens_present_check');
  });
  it('refuses a revoked row that still holds tokens', async () => {
    await expectCheck(
      connection(teacherB, { disconnectedAt: new Date(), revokedAt: new Date() }),
      'ProcessorConnection_tokens_absent_check',
    );
  });
  it('refuses revocation fields on a row that is not disconnected', async () => {
    await expectCheck(connection(teacherC, { revokeAfter: new Date() }), 'ProcessorConnection_revoke_check');
  });
});

describe('ProcessorPayment settling index', () => {
  it('allows at most one settling attempt per payment', async () => {
    const base = {
      paymentId,
      connectionId,
      method: 'ideal',
      status: 'paid' as const,
      amount: new Prisma.Decimal('10.00'),
      currency: 'EUR' as const,
    };
    await prisma.processorPayment.create({ data: { ...base, processorPaymentId: `tr_a${suffix}`, settledPayment: true } });
    await expect(
      prisma.processorPayment.create({ data: { ...base, processorPaymentId: `tr_b${suffix}`, settledPayment: true } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.processorPayment.create({ data: { ...base, processorPaymentId: `tr_c${suffix}`, settledPayment: false } });
  });
});

describe('ProcessorRefund live index', () => {
  it('allows one live refund per attempt, and another after a failure', async () => {
    const first = await prisma.processorRefund.create({ data: { attemptId, amount: new Prisma.Decimal('10.00'), status: 'queued' } });
    await expect(
      prisma.processorRefund.create({ data: { attemptId, amount: new Prisma.Decimal('10.00'), status: 'queued' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.processorRefund.update({ where: { id: first.id }, data: { status: 'failed' } });
    await prisma.processorRefund.create({ data: { attemptId, amount: new Prisma.Decimal('10.00'), status: 'queued' } });
  });
});

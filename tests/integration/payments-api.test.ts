import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const teacherToken = crypto.randomBytes(32).toString('hex');
const otherTeacherToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let otherTeacherId: string;
let roomId: string;
let studentId: string;
let classId: string;
let paymentId: string;

const BASE_URL = 'http://localhost:3000';
const cookie = (token: string) => ({ Cookie: `fair_yoga_session=${token}` });

async function makeTeacher(tag: string, token: string): Promise<string> {
  const email = `pay-${tag}-${uniqueSuffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Pay',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Teacher for payment API tests',
      pageSlug: `pay-${tag}-${uniqueSuffix}`,
    },
  });
  const account = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacher.id },
    select: { accountId: true },
  });
  await prisma.session.create({
    data: {
      id: hashToken(token),
      accountId: account.accountId,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  return teacher.id;
}

beforeAll(async () => {
  await prisma.$connect();
  teacherId = await makeTeacher('owner', teacherToken);
  otherTeacherId = await makeTeacher('other', otherTeacherToken);

  const room = await prisma.room.create({
    data: {
      venueName: 'Payment Venue',
      address: `${uniqueSuffix} Payment St`,
      city: 'Testville',
      postcode: '1234PY',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 10,
      createdById: teacherId,
    },
  });
  roomId = room.id;
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 8, rentalRate: 15 },
  });

  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Reminder Flow',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'completed',
    },
  });
  classId = cls.id;

  const student = await prisma.student.create({
    data: {
      firstName: 'Reminder',
      lastName: 'Student',
      email: `pay-student-${uniqueSuffix}@test.local`,
      incomeTier: 3,
    },
  });
  studentId = student.id;

  const registration = await prisma.registration.create({
    data: { classId, studentId, tierAtBooking: 3, status: 'attended' },
  });
  const payment = await prisma.payment.create({
    data: { registrationId: registration.id, amount: 12.5, status: 'pending' },
  });
  paymentId = payment.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
  await prisma.payment.deleteMany({ where: { registration: { classId } } });
  await prisma.registration.deleteMany({ where: { classId } });
  await prisma.class.deleteMany({ where: { teacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.delete({ where: { id: roomId } });
  await prisma.student.delete({ where: { id: studentId } });
  for (const id of [teacherId, otherTeacherId]) {
    const t = await prisma.teacher.findUniqueOrThrow({
      where: { id },
      select: { accountId: true, email: true },
    });
    await prisma.session.deleteMany({ where: { accountId: t.accountId } });
    await prisma.teacher.delete({ where: { id } });
    await prisma.account.deleteMany({ where: { email: t.email } });
  }
  await prisma.$disconnect();
});

describe('POST /api/payments/[id]/remind', () => {
  it('rejects a signed-out caller', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
  });

  it('404s an unknown payment', async () => {
    const res = await fetch(
      `${BASE_URL}/api/payments/00000000-0000-4000-8000-000000000000/remind`,
      { method: 'POST', headers: cookie(teacherToken) },
    );
    expect(res.status).toBe(404);
  });

  it("403s another teacher's payment", async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(otherTeacherToken),
    });
    expect(res.status).toBe(403);
    expect(
      await prisma.notification.count({
        where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      }),
    ).toBe(0);
  });

  it('creates the notification and stamps reminderSentAt in one go', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { reminderSentAt: string | null } };
    expect(data.reminderSentAt).not.toBeNull();

    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(notification).not.toBeNull();
    expect(notification!.title).toBe('Payment outstanding');

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(stamped.reminderSentAt).not.toBeNull();
  });

  it('409s a payment that is already paid, sending nothing', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'paid' } });
    const before = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });

    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(409);

    const after = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(after).toBe(before);

    // Leave the fixture pending for cleanup symmetry.
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'pending' } });
  });
});

const UNKNOWN_PAYMENT_ID = '00000000-0000-4000-8000-000000000000';
const paid = (token: string | null, id: string, body: unknown = { method: 'cash' }) =>
  fetch(`${BASE_URL}/api/payments/${id}/paid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? cookie(token) : {}) },
    body: JSON.stringify(body),
  });
const unpaid = (token: string | null, id: string) =>
  fetch(`${BASE_URL}/api/payments/${id}/unpaid`, {
    method: 'POST',
    headers: { ...(token ? cookie(token) : {}) },
  });

describe('POST /api/payments/[id]/paid', () => {
  it('rejects a signed-out caller', async () => {
    const res = await paid(null, paymentId);
    expect(res.status).toBe(401);
  });

  it('404s an unknown payment', async () => {
    const res = await paid(teacherToken, UNKNOWN_PAYMENT_ID);
    expect(res.status).toBe(404);
  });

  it("403s another teacher's payment (paid)", async () => {
    const res = await paid(otherTeacherToken, paymentId);
    expect(res.status).toBe(403);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('pending');
  });

  it('400s a body missing method', async () => {
    const res = await paid(teacherToken, paymentId, {});
    expect(res.status).toBe(400);
  });

  it('marks the pending payment paid', async () => {
    const res = await paid(teacherToken, paymentId);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { status: string } };
    expect(data.status).toBe('paid');

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(stamped.status).toBe('paid');
    expect(stamped.method).toBe('cash');
    expect(stamped.paidAt).not.toBeNull();
  });

  it('409s re-marking a payment that is already paid', async () => {
    const res = await paid(teacherToken, paymentId);
    expect(res.status).toBe(409);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('paid');
  });
});

describe('POST /api/payments/[id]/unpaid', () => {
  // Self-seeding: this block mutates the shared fixture payment, so don't
  // depend on the /paid block having run.
  beforeAll(async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'paid', method: 'cash', paidAt: new Date() },
    });
  });

  it('rejects a signed-out caller', async () => {
    const res = await unpaid(null, paymentId);
    expect(res.status).toBe(401);
  });

  it('404s an unknown payment', async () => {
    const res = await unpaid(teacherToken, UNKNOWN_PAYMENT_ID);
    expect(res.status).toBe(404);
  });

  it("403s another teacher's payment (unpaid)", async () => {
    const res = await unpaid(otherTeacherToken, paymentId);
    expect(res.status).toBe(403);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('paid');
  });

  it('undoes the paid payment back to pending', async () => {
    const res = await unpaid(teacherToken, paymentId);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { status: string } };
    expect(data.status).toBe('pending');

    const reverted = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(reverted.status).toBe('pending');
  });

  it('409s a payment that is already pending', async () => {
    const res = await unpaid(teacherToken, paymentId);
    expect(res.status).toBe(409);

    // Read BEFORE any restore: a 409 must have changed nothing.
    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('pending');
    expect(unchanged.method).toBeNull();
    expect(unchanged.paidAt).toBeNull();
  });
});

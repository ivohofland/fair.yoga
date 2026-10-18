import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { expectRefusal } from '../api-assertions';
import { hhmmToTime } from '@/lib/time-of-day';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const compact = suffix.replace(/-/g, '');

/**
 * The Mollie paths that make no outbound call, against the live app: the
 * webhook for an id no attempt has, the attempt route for a teacher with no
 * connection, and "Mark unpaid" on a payment Mollie settled.
 */
describe('Mollie, without Mollie', () => {
  let teacherId = '';
  let teacherAccountId = '';
  let teacherToken = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let roomId = '';
  let pendingPaymentId = '';
  let pendingClassId = '';
  let settledPaymentId = '';

  beforeAll(async () => {
    const teacherEmail = `mollie-webhook-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Hook', lastName: 'Teacher', email: teacherEmail, bio: '', pageSlug: `mollie-webhook-${suffix}`,
        currency: 'EUR', account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    teacherToken = await seedSession(prisma, teacherAccountId);

    const studentEmail = `mollie-webhook-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: { firstName: 'Hook', lastName: 'Student', email: studentEmail, claimedAt: new Date(), account: { create: { email: studentEmail } } },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    const room = await prisma.room.create({
      data: { venueName: 'Hook Studio', address: `${suffix} St`, city: 'Amsterdam', postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: teacherId },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({ data: { teacherId, roomId, capacityOverride: 15, rentalRate: 25 } });

    async function paymentOn(day: number, status: 'pending' | 'paid'): Promise<{ paymentId: string; classId: string }> {
      const cls = await createClassFixture(prisma, {
        teacherId, teacherRoomId: teacherRoom.id, classType: `Hook ${suffix} ${day}`, date: new Date(Date.UTC(2026, 5, day)),
        startTime: hhmmToTime('09:00'), durationMinutes: 60, roomCost: 20, minRate: 10, targetRate: 20, minStudents: 1, maxStudents: 10,
        status: 'completed', effectiveTeacherRate: 10, totalStudents: 1, totalRevenue: 30, vatTotal: 0, currency: 'EUR',
      });
      const registration = await prisma.registration.create({ data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 } });
      const payment = await prisma.payment.create({
        data: { registrationId: registration.id, amount: 10, status, ...(status === 'paid' ? { method: 'mollie', paidAt: new Date() } : {}) },
      });
      return { paymentId: payment.id, classId: cls.id };
    }
    ({ paymentId: pendingPaymentId, classId: pendingClassId } = await paymentOn(1, 'pending'));
    ({ paymentId: settledPaymentId } = await paymentOn(2, 'paid'));
    await prisma.processorPayment.create({
      data: {
        paymentId: settledPaymentId, connectionId: null, processorPaymentId: `tr_hook${compact}`, profileId: 'pfl_hook', testmode: true,
        method: 'ideal', status: 'paid', amount: 10, currency: 'EUR', paidAt: new Date(), settledPayment: true,
      },
    });

    // Warm the routes, so a first-compile delay is not read as the answer.
    await fetch(`${BASE_URL}/api/webhooks/mollie`, { method: 'POST' });
  });

  afterAll(async () => {
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: [teacherAccountId, studentAccountId] } } });
    await prisma.$disconnect();
  });

  describe('POST /api/webhooks/mollie', () => {
    it('answers 200 for an id no attempt has', async () => {
      const res = await fetch(`${BASE_URL}/api/webhooks/mollie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `id=tr_doesnotexist${compact}`,
      });
      expect(res.status).toBe(200);
    });

    it('answers 200 for no body', async () => {
      const res = await fetch(`${BASE_URL}/api/webhooks/mollie`, { method: 'POST' });
      expect(res.status).toBe(200);
    });
  });

  it('POST /api/payments/[id]/processor-attempt refuses a teacher with no Mollie connection: PROCESSOR_NOT_CONNECTED', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${pendingPaymentId}/processor-attempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ method: 'ideal' }),
    });
    await expectRefusal(res, 'PROCESSOR_NOT_CONNECTED');
    expect(await prisma.processorPayment.count({ where: { paymentId: pendingPaymentId } })).toBe(0);
  });

  describe('GET /bookings/[classId]/pay?attempt=', () => {
    async function attemptWith(status: 'pending' | 'failed' | 'open', tag: string) {
      return prisma.processorPayment.create({
        data: {
          paymentId: pendingPaymentId, connectionId: null, processorPaymentId: `tr_hook${tag}${compact}`, profileId: 'pfl_hook',
          testmode: true, method: 'ideal', status, amount: 10, currency: 'EUR',
        },
      });
    }
    async function page(attemptId: string): Promise<string> {
      const res = await fetch(`${BASE_URL}/bookings/${pendingClassId}/pay?attempt=${attemptId}`, { headers: cookie(studentToken) });
      expect(res.status).toBe(200);
      return res.text();
    }

    it('says a processing payment is processing, and shows it as the claim is shown', async () => {
      const attempt = await attemptWith('pending', 'p');
      try {
        const html = await page(attempt.id);
        expect(html).toContain('Processing — we’ll let you know.');
        expect(html).toContain('>Processing<');
      } finally {
        await prisma.processorPayment.delete({ where: { id: attempt.id } });
      }
    });

    it('says a failed payment did not go through', async () => {
      const attempt = await attemptWith('failed', 'f');
      try {
        const html = await page(attempt.id);
        expect(html).toContain('That payment didn’t go through. You can try again below.');
        expect(html).not.toContain('>Processing<');
      } finally {
        await prisma.processorPayment.delete({ where: { id: attempt.id } });
      }
    });

    it('says nothing for an open attempt, or one that is not this payment’s', async () => {
      const attempt = await attemptWith('open', 'o');
      try {
        for (const id of [attempt.id, 'not-an-attempt']) {
          const html = await page(id);
          expect(html).not.toContain('data-testid="attempt-banner"');
        }
      } finally {
        await prisma.processorPayment.delete({ where: { id: attempt.id } });
      }
    });
  });

  it('POST /api/payments/[id]/unpaid refuses a payment Mollie settled: PAYMENT_SETTLED_BY_PROCESSOR', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${settledPaymentId}/unpaid`, {
      method: 'POST',
      headers: cookie(teacherToken),
    });
    await expectRefusal(res, 'PAYMENT_SETTLED_BY_PROCESSOR');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: settledPaymentId } })).status).toBe('paid');
  });
});

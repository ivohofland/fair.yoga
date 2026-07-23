import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  markPaymentPaid,
  markPaymentOverdue,
  unmarkPaymentPaid,
  sendPaymentReminder,
  getOutstandingPayments,
  getPaymentsForClass,
} from './payments';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

describe('Payment Service (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let classId: string;
  let studentId: string;
  let registrationId: string;
  let paymentId: string;

  beforeAll(async () => {
    // Create teacher
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Payment',
        lastName: 'Teacher',
        email: `payment-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `payment-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Test teacher for payment tests',
        pageSlug: `payment-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    // Create room
    const room = await prisma.room.create({
      data: {
        venueName: 'Payment Studio',
        address: `${uniqueSuffix} Payment St`,
        city: 'Amsterdam',
        postcode: '1234PM',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    // Create teacherRoom
    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId,
        capacityOverride: 15,
        rentalRate: 35,
      },
    });
    teacherRoomId = teacherRoom.id;

    // Create completed class
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'completed',
        settingsLocked: true,
      },
    });
    classId = cls.id;

    // Create student
    const student = await prisma.student.create({
      data: {
        firstName: 'PaymentStudent',
        lastName: 'Test',
        email: `payment-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;

    // Create registration (attended, with price and tierRatio)
    const registration = await prisma.registration.create({
      data: {
        classId,
        studentId,
        status: 'attended',
        tierAtBooking: 3,
        price: 24.59,
        tierRatio: 1.0,
      },
    });
    registrationId = registration.id;

    // Create pending payment
    const payment = await prisma.payment.create({
      data: {
        registrationId,
        amount: 24.59,
        status: 'pending',
      },
    });
    paymentId = payment.id;
  });

  afterAll(async () => {
    // Clean up in dependency order
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.payment.deleteMany({ where: { registrationId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('markPaymentPaid updates status, method, and paidAt', async () => {
    const result = await markPaymentPaid(prisma, paymentId, 'bank_transfer');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe('paid');
      expect(result.payment.method).toBe('bank_transfer');
      expect(result.payment.paidAt).not.toBeNull();
    }
  });

  it('markPaymentPaid rejects invalid status transition', async () => {
    // Payment is currently 'paid' from the previous test — should not allow re-paying
    const result = await markPaymentPaid(prisma, paymentId, 'cash');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('paid');
    }
  });

  it('markPaymentOverdue updates status to overdue', async () => {
    // Reset to pending first so we can test the transition
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending', method: null, paidAt: null },
    });

    const result = await markPaymentOverdue(prisma, paymentId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe('overdue');
    }
  });

  it('markPaymentOverdue rejects non-pending status', async () => {
    // Payment is currently 'overdue' from the previous test
    const result = await markPaymentOverdue(prisma, paymentId);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('overdue');
    }
  });

  it('markPaymentPaid allows transition from overdue', async () => {
    // Payment is currently 'overdue' — should be allowed to mark as paid
    const result = await markPaymentPaid(prisma, paymentId, 'cash');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe('paid');
      expect(result.payment.method).toBe('cash');
    }
  });

  it('unmarkPaymentPaid undoes a mistaken mark: paid → pending, fields cleared', async () => {
    // paymentId is 'paid' from the previous test
    const result = await unmarkPaymentPaid(prisma, paymentId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payment.status).toBe('pending');
      expect(result.payment.method).toBeNull();
      expect(result.payment.paidAt).toBeNull();
    }
  });

  it('unmarkPaymentPaid rejects when the payment is not paid', async () => {
    // now 'pending' after the undo above
    const result = await unmarkPaymentPaid(prisma, paymentId);
    expect(result.ok).toBe(false);
  });

  it('re-marking paid after an undo works', async () => {
    const result = await markPaymentPaid(prisma, paymentId, 'cash');
    expect(result.ok).toBe(true);
  });

  it('sendPaymentReminder refuses a paid payment and sends nothing', async () => {
    // The payment is 'paid' here (re-marked just above). A settled payment
    // has nothing to chase — the guard must reject it without notifying.
    const before = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });

    const result = await sendPaymentReminder(prisma, paymentId);
    expect(result.ok).toBe(false);

    const after = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(after).toBe(before);
  });

  it('sendPaymentReminder stamps and notifies an outstanding payment', async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending', method: null, paidAt: null },
    });

    const result = await sendPaymentReminder(prisma, paymentId);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected the reminder to send');
    expect(result.payment.reminderSentAt).not.toBeNull();

    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(notification).not.toBeNull();
  });

  it('getOutstandingPayments returns pending/overdue payments for teacher', async () => {
    // Reset to pending so it shows up as outstanding
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending', method: null, paidAt: null },
    });

    const payments = await getOutstandingPayments(prisma, teacherId);

    expect(payments.length).toBeGreaterThanOrEqual(1);

    const ourPayment = payments.find((p) => p.id === paymentId);
    expect(ourPayment).toBeDefined();
  });

  it('getPaymentsForClass returns all payments for a class', async () => {
    const payments = await getPaymentsForClass(prisma, classId);

    expect(payments.length).toBeGreaterThanOrEqual(1);

    const ourPayment = payments.find((p) => p.id === paymentId);
    expect(ourPayment).toBeDefined();
  });
});

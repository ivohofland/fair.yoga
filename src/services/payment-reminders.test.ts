import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  markOverduePayments,
  sendPaymentReminders,
  processPaymentReminders,
} from './payment-reminders';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('payment reminders (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let classId: string;
  const paymentIds: string[] = [];
  const registrationIds: string[] = [];

  async function makePayment(createdAt: Date, status: 'pending' | 'overdue' = 'pending', reminderSentAt: Date | null = null) {
    const student = await prisma.student.create({
      data: {
        firstName: 'Pay',
        lastName: `S${paymentIds.length}`,
        email: `payrem-${uniqueSuffix}-${paymentIds.length}@test.local`,
        incomeTier: 3,
      },
    });
    const reg = await prisma.registration.create({
      data: { classId, studentId: student.id, status: 'attended', tierAtBooking: 3, price: 12.5 },
    });
    registrationIds.push(reg.id);
    const payment = await prisma.payment.create({
      data: { registrationId: reg.id, amount: 12.5, status, createdAt, reminderSentAt },
    });
    paymentIds.push(payment.id);
    return payment;
  }

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'PayRem',
        lastName: 'Teacher',
        email: `payrem-teacher-${uniqueSuffix}@test.local`,
        bio: 'Payment reminder tests',
        pageSlug: `payrem-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'PayRem Studio',
        address: `${uniqueSuffix} PayRem St`,
        city: 'Amsterdam',
        postcode: '1234PR',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
    });
    teacherRoomId = tr.id;

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'PayRem Hatha',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 12,
        status: 'completed',
      },
    });
    classId = cls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'PayRem',
        lastName: 'Student',
        email: `payrem-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.class.delete({ where: { id: classId } });
    await prisma.student.deleteMany({ where: { email: { contains: `payrem-${uniqueSuffix}` } } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  const DAY = 24 * 60 * 60 * 1000;
  const now = new Date('2026-07-01T12:00:00Z');

  it('marks pending payments overdue after 7 days, leaves younger ones', async () => {
    const old = await makePayment(new Date(now.getTime() - 8 * DAY));
    const fresh = await makePayment(new Date(now.getTime() - 2 * DAY));

    await markOverduePayments(prisma, now);

    const oldAfter = await prisma.payment.findUniqueOrThrow({ where: { id: old.id } });
    const freshAfter = await prisma.payment.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(oldAfter.status).toBe('overdue');
    expect(freshAfter.status).toBe('pending');
  });

  it('reminds overdue payments once, then not again within 7 days', async () => {
    const payment = await makePayment(new Date(now.getTime() - 10 * DAY), 'overdue');

    const first = await sendPaymentReminders(prisma, now);
    expect(first).toBeGreaterThanOrEqual(1);

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(stamped.reminderSentAt).not.toBeNull();

    // Second run one day later: within the 7-day window, no repeat.
    const oneDayLater = new Date(now.getTime() + 1 * DAY);
    const repeats = await sendPaymentReminders(prisma, oneDayLater);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.reminderSentAt?.getTime()).toBe(stamped.reminderSentAt?.getTime());
    void repeats; // other tests' payments may legitimately be reminded here

    // Eight days later the same payment is due for a repeat nudge.
    const eightDaysLater = new Date(now.getTime() + 8 * DAY);
    await sendPaymentReminders(prisma, eightDaysLater);
    const reReminded = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(reReminded.reminderSentAt?.getTime()).toBe(eightDaysLater.getTime());
  });

  it('creates a calm reminder notification with the amount', async () => {
    const payment = await makePayment(new Date(now.getTime() - 9 * DAY), 'overdue');
    await sendPaymentReminders(prisma, now);

    const reg = await prisma.registration.findUniqueOrThrow({
      where: { id: payment.registrationId },
      select: { studentId: true },
    });
    const note = await prisma.notification.findFirst({
      where: { recipientId: reg.studentId, type: 'reminder', relatedClassId: classId },
    });
    expect(note).not.toBeNull();
    expect(note!.body).toContain('€12.50');
    expect(note!.body).not.toContain('!');
  });

  it('processPaymentReminders runs both phases', async () => {
    const payment = await makePayment(new Date(now.getTime() - 8 * DAY));
    const result = await processPaymentReminders(prisma, now);
    expect(result.markedOverdue).toBeGreaterThanOrEqual(1);
    expect(result.reminded).toBeGreaterThanOrEqual(1);

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe('overdue');
    expect(after.reminderSentAt).not.toBeNull();
  });
});

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
  let studentAccountId: string;
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

    // Create student — claimed, with a privacy row that shares the email and
    // not the surname.
    //
    // All three of those are load-bearing, and none was here until #167's
    // round-two review.
    //
    // Claimed: an unclaimed student trips `bypassesPrivacy`, which ungates
    // every field before any flag is read. The projection then returns the
    // same full profile for every teacher, so the `teacherId` threaded through
    // `getOutstandingPayments`/`getPaymentsForClass` was inert — a reviewer
    // substituted a foreign UUID for it and this file stayed 14/14 green.
    //
    // Shares the email: claiming alone does not fix that. With an all-false
    // row, the owning teacher's read and a foreign teacher's read are
    // byte-identical — a row of all-false flags and *no row at all* both
    // project every field to `null`. Verified: with an all-false row the
    // foreign-UUID substitution was still 15/15 green. One released field is
    // what makes "whose row did it read" observable at all.
    //
    // Does not share the surname: a truncated display name is not a fixed
    // point of `formatStudentName`, so it can only appear if the flags were
    // read — which is what pins that `bypassesPrivacy` did not fire.
    const studentEmail = `payment-student-${uniqueSuffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'PaymentStudent',
        lastName: 'Test',
        email: studentEmail,
        incomeTier: 3,
        claimedAt: new Date(),
        // `Student_claim_link_check` requires claimedAt and accountId to move
        // together, so the account is not optional here.
        account: { create: { email: studentEmail } },
      },
    });
    studentId = student.id;
    studentAccountId = student.accountId!;

    await prisma.studentPrivacy.create({
      data: { studentId, teacherId, shareEmail: true, shareFullName: false },
    });

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
    // StudentPrivacy cascades off the student; the account does not.
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.account.delete({ where: { id: studentAccountId } });
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
    // A settled payment has nothing to chase — the guard must reject it
    // without notifying. Set paid here rather than leaning on a prior test.
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'paid' } });
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

  /**
   * `teacherId` does two jobs in both queries below — it scopes the `where`,
   * and it selects which `StudentPrivacy` row the projection reads (see
   * `getPaymentsForClass`'s docblock). The three tests below cover both:
   * the two foreign-teacher reads falsify the `where` scope, and the
   * truncated-name assertion falsifies the projection argument.
   *
   * That last one is the addition from #167's round-two review, and the
   * comment that used to stand here misdiagnosed why it was needed. It blamed
   * "every fixture in this file happens to read as the owning teacher" — true,
   * but not what made the projection argument inert. The cause was the
   * fixture's *unclaimed* student: `bypassesPrivacy` returned true, so every
   * field came back ungated no matter whose `teacherId` was passed, and
   * substituting a foreign UUID at the call site left this file 14/14 green.
   * The student is claimed now, with an all-false row for `teacherId`.
   *
   * The same comment also called the two foreign-teacher tests below a thing
   * still to be added; they have been here since the previous review round.
   * `getPaymentsForClass` is the one that matters most, because it takes a
   * `classId` a caller could have got from anywhere.
   */
  const FOREIGN_TEACHER = '00000000-0000-4000-8000-000000000000';

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

  it('getOutstandingPayments returns nothing for a teacher who owns none', async () => {
    expect(await getOutstandingPayments(prisma, FOREIGN_TEACHER)).toEqual([]);
  });

  it('getPaymentsForClass returns all payments for a class', async () => {
    const payments = await getPaymentsForClass(prisma, classId, teacherId);

    expect(payments.length).toBeGreaterThanOrEqual(1);

    const ourPayment = payments.find((p) => p.id === paymentId);
    expect(ourPayment).toBeDefined();
  });

  it('getPaymentsForClass returns nothing for a teacher who does not own the class', async () => {
    expect(await getPaymentsForClass(prisma, classId, FOREIGN_TEACHER)).toEqual([]);
  });

  /**
   * The projection half of `teacherId`'s job, and the only assertion in this
   * file that can see it. Two directions, both needed:
   *
   * - the released `email` says the projection read *this* teacher's row.
   *   Substituting a foreign UUID for the `teacherId` passed to
   *   `projectStudentForTeacher` in `payments.ts` finds no row, withholds the
   *   email, and reddens this.
   * - the truncated `displayName` says it read the flags at all rather than
   *   taking the `bypassesPrivacy` shortcut. Un-claiming the fixture student
   *   ungates the surname and reddens this.
   *
   * Neither alone is enough, which is how this file passed 14/14 with the
   * argument inert.
   */
  it('projects the student under the OWNING teacher\'s privacy flags', async () => {
    const [outstanding] = await getOutstandingPayments(prisma, teacherId);
    if (!outstanding) throw new Error('expected an outstanding payment');
    expect(outstanding.registration.student.displayName).toBe('PaymentStudent t.');
    expect(outstanding.registration.student.email).toBe(
      `payment-student-${uniqueSuffix}@test.local`,
    );
    // Still per-field: this row shares the email and nothing else.
    expect(outstanding.registration.student.phone).toBeNull();

    const [forClass] = await getPaymentsForClass(prisma, classId, teacherId);
    if (!forClass) throw new Error('expected a payment for the class');
    expect(forClass.registration.student.displayName).toBe('PaymentStudent t.');
    expect(forClass.registration.student.email).toBe(
      `payment-student-${uniqueSuffix}@test.local`,
    );
  });
});

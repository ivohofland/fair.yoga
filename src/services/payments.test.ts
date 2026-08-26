import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  markPaymentPaid,
  markPaymentOverdue,
  unmarkPaymentPaid,
  sendPaymentReminder,
  getOutstandingPayments,
  getPaymentsForClass,
  MANUAL_REMIND_COOLDOWN_MS,
} from './payments';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

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
    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'completed',
        settingsLocked: true,
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: classId } } } });
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

  /**
   * The manual reminder's cooldown (#196).
   *
   * Last in the file, deliberately. Every payment made here is outstanding
   * while its test runs, and the projection test above makes two unordered
   * `[0]` reads — `getPaymentsForClass(prisma, classId, teacherId)[0]` and
   * `getOutstandingPayments(prisma, teacherId)[0]`, the first the more exposed
   * of the two because the fixtures share one class — so a
   * second outstanding row for this teacher earlier in the file would decide
   * those assertions by luck.
   */
  describe('manual reminder cooldown', () => {
    // Each test gets its own student so it can count that student's reminder
    // notifications without seeing the shared fixture's. The registrations
    // hang off the shared class, so the parent `afterAll`'s
    // `relatedClassId` notification sweep already covers what they produce.
    const cooldownStudentIds: string[] = [];

    async function makeOutstandingPayment(tag: string): Promise<{
      paymentId: string;
      studentId: string;
    }> {
      const student = await prisma.student.create({
        data: {
          firstName: 'Cooldown',
          lastName: tag,
          email: `payment-cooldown-${tag}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
        },
        select: { id: true },
      });
      cooldownStudentIds.push(student.id);
      const registration = await prisma.registration.create({
        data: { classId, studentId: student.id, status: 'attended', tierAtBooking: 3, price: 12.5 },
      });
      const payment = await prisma.payment.create({
        data: { registrationId: registration.id, amount: 12.5, status: 'pending' },
      });
      return { paymentId: payment.id, studentId: student.id };
    }

    afterAll(async () => {
      // Nested `afterAll`s run before their parent's, and Registration and
      // Payment both cascade off Student, so this is the whole cleanup.
      await prisma.student.deleteMany({ where: { id: { in: cooldownStudentIds } } });
    });

    it('refuses a second manual reminder inside the cooldown, sending nothing', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('inside');
      expect((await sendPaymentReminder(prisma, id)).ok).toBe(true);

      const second = await sendPaymentReminder(prisma, id);

      // The notification count comes before the `ok` assertion, deliberately:
      // the defect is a student dunned twice for one debt, and this is the
      // assertion whose failure message names it.
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(1);
      expect(second.ok).toBe(false);
    });

    it('allows a manual reminder once the cooldown has lapsed', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('lapsed');
      expect((await sendPaymentReminder(prisma, id)).ok).toBe(true);

      // Backdate the stamp past the window rather than sleeping two minutes.
      await prisma.payment.update({
        where: { id },
        data: { reminderSentAt: new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS - 1000) },
      });

      expect((await sendPaymentReminder(prisma, id)).ok).toBe(true);
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(2);
    });

    it('blames the status, not the cooldown, when a just-reminded payment was settled', async () => {
      const { paymentId: id } = await makeOutstandingPayment('settled');
      expect((await sendPaymentReminder(prisma, id)).ok).toBe(true);
      await prisma.payment.update({ where: { id }, data: { status: 'paid' } });

      // Both terms of the WHERE now fail at once. The status is the one worth
      // reporting: "try again in a couple of minutes" would promise a retry
      // that the status guard refuses forever.
      const refused = await sendPaymentReminder(prisma, id);
      if (refused.ok) throw new Error('expected the reminder to be refused');
      expect(refused.error).toContain('"paid"');
    });
  });
});

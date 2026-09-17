import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type Payment, type PaymentStatus } from '@prisma/client';
import {
  markPaymentPaid,
  markPaymentOverdue,
  reopenPayment,
  markPaymentNotCharged,
  sendPaymentReminder,
  getOutstandingPayments,
  getPaymentsForClass,
  countOutstandingPaymentsForStudent,
  MANUAL_REMIND_COOLDOWN_MS,
  type PaymentOutcome,
  type PaymentRefusal,
} from './payments';
import { hhmmToTime } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

/** The row an `applied` or `unchanged` outcome carries; throws, naming the outcome, otherwise. */
function paymentOf(outcome: PaymentOutcome, kind: 'applied' | 'unchanged'): Payment {
  if (outcome.kind === 'refused' || outcome.kind !== kind) {
    throw new Error(`expected ${kind}, got ${JSON.stringify(outcome)}`);
  }
  return outcome.payment;
}

/** The code a refused outcome carries; throws, naming the outcome, otherwise. */
function refusalCode(outcome: PaymentOutcome): PaymentRefusal['code'] {
  if (outcome.kind !== 'refused') {
    throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  }
  return outcome.refusal.code;
}

/**
 * A client whose `payment.updateMany` runs `between` once, after the write and
 * before anything else: the window in which a concurrent action lands between
 * a service's compare-and-swap and its re-read. `fired` says whether it ran, so
 * a test can tell its interleaving from a hook that never fired.
 *
 * `$extends` returns a client missing `$on`, so the result is cast to the
 * `PrismaClient` the services take; every method they call is the real one.
 */
function interposeAfterPaymentWrite(between: () => Promise<unknown>): {
  db: PrismaClient;
  fired: () => boolean;
} {
  let armed = true;
  const db = prisma.$extends({
    query: {
      payment: {
        async updateMany({ args, query }) {
          const result = await query(args);
          if (armed) {
            armed = false;
            await between();
          }
          return result;
        },
      },
    },
  }) as unknown as PrismaClient;
  return { db, fired: () => !armed };
}

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
    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'bank_transfer'), 'applied');

    expect(payment.status).toBe('paid');
    expect(payment.method).toBe('bank_transfer');
    expect(payment.paidAt).not.toBeNull();
  });

  it('markPaymentPaid answers unchanged for a payment already paid that way, writing nothing', async () => {
    // Paid with 'bank_transfer' by the previous test.
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'bank_transfer'), 'unchanged');

    expect(payment.method).toBe('bank_transfer');
    expect(payment.paidAt).toEqual(before.paidAt);
    expect(payment.updatedAt).toEqual(before.updatedAt);
  });

  it('markPaymentPaid refuses a paid payment when the method differs', async () => {
    expect(refusalCode(await markPaymentPaid(prisma, paymentId, 'cash'))).toBe('PAYMENT_ALREADY_PAID');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(row.method).toBe('bank_transfer');
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
    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'cash'), 'applied');

    expect(payment.status).toBe('paid');
    expect(payment.method).toBe('cash');
  });

  it('reopenPayment undoes a mistaken mark: paid → pending, fields cleared', async () => {
    // paymentId is 'paid' from the previous test
    const payment = paymentOf(await reopenPayment(prisma, paymentId), 'applied');

    expect(payment.status).toBe('pending');
    expect(payment.method).toBeNull();
    expect(payment.paidAt).toBeNull();
  });

  it('reopenPayment answers unchanged when the payment is already outstanding', async () => {
    // now 'pending' after the undo above
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const payment = paymentOf(await reopenPayment(prisma, paymentId), 'unchanged');

    expect(payment.status).toBe('pending');
    expect(payment.updatedAt).toEqual(before.updatedAt);
  });

  it('re-marking paid after an undo works', async () => {
    expect(paymentOf(await markPaymentPaid(prisma, paymentId, 'cash'), 'applied').status).toBe('paid');
  });

  it('sendPaymentReminder refuses a paid payment and sends nothing', async () => {
    // A settled payment has nothing to chase — the guard must reject it
    // without notifying. Set paid here rather than leaning on a prior test.
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'paid' } });
    const before = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });

    expect(refusalCode(await sendPaymentReminder(prisma, paymentId))).toBe('PAYMENT_SETTLED');

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

    const payment = paymentOf(await sendPaymentReminder(prisma, paymentId), 'applied');
    expect(payment.reminderSentAt).not.toBeNull();

    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(notification.body).toContain('Hatha');
    expect(notification.body).toContain(formatDayHeader(new Date('2026-06-01')));
    expect(notification.body).toContain('09:00');
    expect(notification.body).toContain('is still open. Pay your teacher directly.');
    expect(notification.body).toContain('€24.59');
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

    it('answers a second manual reminder inside the cooldown unchanged, sending nothing', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('inside');
      const first = paymentOf(await sendPaymentReminder(prisma, id), 'applied');

      const second = await sendPaymentReminder(prisma, id);

      // The notification count comes before the outcome assertion, deliberately:
      // the defect is a student dunned twice for one debt, and this is the
      // assertion whose failure message names it.
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(1);
      const repeated = paymentOf(second, 'unchanged');
      expect(repeated.reminderSentAt).toEqual(first.reminderSentAt);
      expect(repeated.updatedAt).toEqual(first.updatedAt);
    });

    it('answers unchanged to a fresh stamp it did not write, sending nothing', async () => {
      // `reminderSentAt` is the column the overdue sweep stamps too.
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('swept');
      const sweptAt = new Date();
      await prisma.payment.update({
        where: { id },
        data: { status: 'overdue', reminderSentAt: sweptAt },
      });

      const result = await sendPaymentReminder(prisma, id);

      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(0);
      expect(paymentOf(result, 'unchanged').reminderSentAt).toEqual(sweptAt);
    });

    it('allows a manual reminder once the cooldown has lapsed', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('lapsed');
      paymentOf(await sendPaymentReminder(prisma, id), 'applied');

      // Backdate the stamp past the window rather than sleeping two minutes.
      await prisma.payment.update({
        where: { id },
        data: { reminderSentAt: new Date(Date.now() - MANUAL_REMIND_COOLDOWN_MS - 1000) },
      });

      paymentOf(await sendPaymentReminder(prisma, id), 'applied');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(2);
    });

    it('refuses a just-reminded payment that was settled with PAYMENT_SETTLED, not unchanged', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('settled');
      paymentOf(await sendPaymentReminder(prisma, id), 'applied');
      await prisma.payment.update({ where: { id }, data: { status: 'paid' } });

      // Both terms of the WHERE now fail at once. Settled makes the reminder
      // moot, so it answers first: `unchanged` would report a reminder on a
      // payment that no longer needs one.
      expect(refusalCode(await sendPaymentReminder(prisma, id))).toBe('PAYMENT_SETTLED');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(1);
    });

    it('refuses a not-charged payment with PAYMENT_SETTLED, sending nothing', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('waived');
      await prisma.payment.update({
        where: { id },
        data: { status: 'not_charged', notChargedAt: new Date() },
      });

      expect(refusalCode(await sendPaymentReminder(prisma, id))).toBe('PAYMENT_SETTLED');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(0);
    });

    it('refuses with CONCURRENT_MODIFICATION when the stamp it missed is gone by its re-read', async () => {
      const { paymentId: id, studentId: sid } = await makeOutstandingPayment('raced');
      paymentOf(await sendPaymentReminder(prisma, id), 'applied');
      const racing = interposeAfterPaymentWrite(() =>
        prisma.payment.update({ where: { id }, data: { reminderSentAt: null } }),
      );

      const result = await sendPaymentReminder(racing.db, id);

      expect(racing.fired()).toBe(true);
      // `unchanged` would claim a reminder went out moments ago; the row no
      // longer says so.
      expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      expect(
        await prisma.notification.count({
          where: { recipientType: 'student', recipientId: sid, type: 'reminder' },
        }),
      ).toBe(1);
    });
  });

  /**
   * `markPaymentNotCharged` and `reopenPayment`, both against payments of their
   * own — the sequential fixture above leaves `paymentId` in whatever state its
   * last test left it, which these don't depend on.
   */
  describe('markPaymentNotCharged / reopenPayment', () => {
    const fixtureStudentIds: string[] = [];
    let fixtureTag = 0;

    async function makePayment(status: PaymentStatus): Promise<Payment> {
      const tag = fixtureTag++;
      const student = await prisma.student.create({
        data: {
          firstName: 'NotCharged',
          lastName: `Fixture${tag}`,
          email: `payment-notcharged-${tag}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
        },
        select: { id: true },
      });
      fixtureStudentIds.push(student.id);
      const registration = await prisma.registration.create({
        data: { classId, studentId: student.id, status: 'attended', tierAtBooking: 3, price: 12.5 },
      });
      return prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: 12.5,
          status,
          ...(status === 'paid' ? { method: 'cash', paidAt: new Date() } : {}),
          ...(status === 'not_charged' ? { notChargedAt: new Date() } : {}),
        },
      });
    }

    afterAll(async () => {
      // Nested `afterAll`s run before their parent's, and Registration and
      // Payment both cascade off Student, so this is the whole cleanup.
      await prisma.student.deleteMany({ where: { id: { in: fixtureStudentIds } } });
    });

    describe('markPaymentNotCharged', () => {
      it('settles a pending payment and stamps notChargedAt', async () => {
        const payment = await makePayment('pending');
        paymentOf(await markPaymentNotCharged(prisma, payment.id), 'applied');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('not_charged');
        expect(row.notChargedAt).not.toBeNull();
        expect(row.paidAt).toBeNull();
      });

      it('settles an overdue payment', async () => {
        const payment = await makePayment('overdue');
        expect(paymentOf(await markPaymentNotCharged(prisma, payment.id), 'applied').status).toBe(
          'not_charged',
        );
      });

      it('refuses a paid payment with PAYMENT_ALREADY_PAID — that would be a refund', async () => {
        const payment = await makePayment('paid');
        expect(refusalCode(await markPaymentNotCharged(prisma, payment.id))).toBe(
          'PAYMENT_ALREADY_PAID',
        );
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('paid');
        expect(row.notChargedAt).toBeNull();
      });

      it('answers a payment already not charged unchanged, writing nothing', async () => {
        const payment = await makePayment('not_charged');
        const row = paymentOf(await markPaymentNotCharged(prisma, payment.id), 'unchanged');
        expect(row.notChargedAt).toEqual(payment.notChargedAt);
        expect(row.updatedAt).toEqual(payment.updatedAt);
      });

      it('markPaymentPaid refuses a not-charged payment with PAYMENT_WAIVED', async () => {
        const payment = await makePayment('not_charged');
        expect(refusalCode(await markPaymentPaid(prisma, payment.id, 'cash'))).toBe('PAYMENT_WAIVED');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('not_charged');
      });
    });

    describe('reopenPayment', () => {
      it('returns a paid payment to pending, clearing method and paidAt', async () => {
        const payment = await makePayment('paid');
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('pending');
        expect(row.paidAt).toBeNull();
        expect(row.method).toBeNull();
      });

      it('returns a not-charged payment to pending, clearing notChargedAt', async () => {
        const payment = await makePayment('not_charged');
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.status).toBe('pending');
        expect(row.notChargedAt).toBeNull();
      });

      it.each(['pending', 'overdue'] as const)(
        'answers a %s payment unchanged, carrying its status and writing nothing',
        async (status) => {
          const payment = await makePayment(status);
          const row = paymentOf(await reopenPayment(prisma, payment.id), 'unchanged');
          expect(row.status).toBe(status);
          expect(row.updatedAt).toEqual(payment.updatedAt);
        },
      );
    });

    /**
     * A compare-and-swap that misses, then a re-read that finds a state the
     * swap would have accepted: another action landed between the two
     * statements, and neither "already done" nor a status refusal is true of
     * that row.
     */
    describe('a write that lands between the swap and the re-read', () => {
      it('markPaymentPaid: a paid payment reopened in between → CONCURRENT_MODIFICATION', async () => {
        const payment = await makePayment('paid');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'pending', method: null, paidAt: null },
          }),
        );

        const result = await markPaymentPaid(racing.db, payment.id, 'cash');

        expect(racing.fired()).toBe(true);
        expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      });

      it('markPaymentNotCharged: a not-charged payment reopened in between → CONCURRENT_MODIFICATION', async () => {
        const payment = await makePayment('not_charged');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'pending', notChargedAt: null },
          }),
        );

        const result = await markPaymentNotCharged(racing.db, payment.id);

        expect(racing.fired()).toBe(true);
        expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      });

      it('reopenPayment: a pending payment settled in between → CONCURRENT_MODIFICATION', async () => {
        const payment = await makePayment('pending');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({
            where: { id: payment.id },
            data: { status: 'paid', method: 'cash', paidAt: new Date() },
          }),
        );

        const result = await reopenPayment(racing.db, payment.id);

        expect(racing.fired()).toBe(true);
        expect(refusalCode(result)).toBe('CONCURRENT_MODIFICATION');
      });
    });
  });

  /** What each function answers when the payment id names no row. */
  describe('a payment that does not exist', () => {
    const UNKNOWN_PAYMENT_ID = '00000000-0000-4000-8000-000000000000';

    it.each([
      ['markPaymentPaid', () => markPaymentPaid(prisma, UNKNOWN_PAYMENT_ID, 'cash')],
      ['markPaymentNotCharged', () => markPaymentNotCharged(prisma, UNKNOWN_PAYMENT_ID)],
      ['reopenPayment', () => reopenPayment(prisma, UNKNOWN_PAYMENT_ID)],
      ['sendPaymentReminder', () => sendPaymentReminder(prisma, UNKNOWN_PAYMENT_ID)],
    ] as const)('%s answers NOT_FOUND', async (_name, act) => {
      expect(refusalCode(await act())).toBe('NOT_FOUND');
    });
  });
});

describe('countOutstandingPaymentsForStudent (DB)', () => {
  const suffix = `${Date.now()}-scope`;
  let teacherAId: string;
  let teacherBId: string;
  let studentAId: string;
  let studentAAccountId: string;
  let studentBId: string;
  let studentBAccountId: string;
  const classIds: string[] = [];
  const registrationIds: string[] = [];

  async function makeTeacher(label: string) {
    const email = `payment-scope-teacher-${label.toLowerCase()}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: label,
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: 'Test teacher for payment scoping tests',
        pageSlug: `payment-scope-${label}-${suffix}`,
      },
    });
    const room = await prisma.room.create({
      data: {
        venueName: `${label} Studio`,
        address: `${suffix} ${label} St`,
        city: 'Amsterdam',
        postcode: '1234PM',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 35 },
    });
    return { teacherId: teacher.id, teacherRoomId: teacherRoom.id };
  }

  async function makeStudent(label: string) {
    const email = `payment-scope-student-${label.toLowerCase()}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: label,
        lastName: 'Student',
        email,
        incomeTier: 3,
        claimedAt: new Date(),
        account: { create: { email } },
      },
    });
    return { studentId: student.id, accountId: student.accountId! };
  }

  // One registration + payment, on its own class so the teacher-slot
  // exclusion constraint never collides between fixture rows.
  async function makeOutstandingRow(
    teacherRoomId: string,
    teacherId: string,
    studentId: string,
    day: string,
    status: PaymentStatus,
  ) {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Hatha',
      date: new Date(day),
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
    classIds.push(cls.id);
    const registration = await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3, price: 20, tierRatio: 1.0 },
    });
    registrationIds.push(registration.id);
    await prisma.payment.create({ data: { registrationId: registration.id, amount: 20, status } });
  }

  beforeAll(async () => {
    const teacherA = await makeTeacher('A');
    const teacherB = await makeTeacher('B');
    teacherAId = teacherA.teacherId;
    teacherBId = teacherB.teacherId;
    const studentA = await makeStudent('A');
    const studentB = await makeStudent('B');
    studentAId = studentA.studentId;
    studentAAccountId = studentA.accountId;
    studentBId = studentB.studentId;
    studentBAccountId = studentB.accountId;

    // Student A, teacher A: two outstanding (pending + overdue), one settled
    // (paid) and one waived (not_charged) — the pair the count must exclude.
    await makeOutstandingRow(teacherA.teacherRoomId, teacherAId, studentAId, '2026-06-01', 'pending');
    await makeOutstandingRow(teacherA.teacherRoomId, teacherAId, studentAId, '2026-06-02', 'overdue');
    await makeOutstandingRow(teacherA.teacherRoomId, teacherAId, studentAId, '2026-06-03', 'paid');
    await makeOutstandingRow(teacherA.teacherRoomId, teacherAId, studentAId, '2026-06-04', 'not_charged');
    // Student B, teacher A: one outstanding — must not leak into student A's count.
    await makeOutstandingRow(teacherA.teacherRoomId, teacherAId, studentBId, '2026-06-05', 'pending');
    // Student A, teacher B: one outstanding — must not leak into teacher A's count.
    await makeOutstandingRow(teacherB.teacherRoomId, teacherBId, studentAId, '2026-06-06', 'pending');
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { registrationId: { in: registrationIds } } });
    await prisma.registration.deleteMany({ where: { id: { in: registrationIds } } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
    await prisma.student.deleteMany({ where: { id: { in: [studentAId, studentBId] } } });
    await prisma.account.deleteMany({ where: { id: { in: [studentAAccountId, studentBAccountId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: [teacherAId, teacherBId] } } });
    await prisma.room.deleteMany({ where: { createdById: { in: [teacherAId, teacherBId] } } });
    await prisma.teacher.deleteMany({ where: { id: { in: [teacherAId, teacherBId] } } });
  });

  it('counts only pending and overdue payments, excluding paid and not_charged', async () => {
    expect(await countOutstandingPaymentsForStudent(prisma, studentAId, teacherAId)).toBe(2);
  });

  it('excludes outstanding payments owed by a different student', async () => {
    expect(await countOutstandingPaymentsForStudent(prisma, studentBId, teacherAId)).toBe(1);
  });

  it('excludes outstanding payments owed to a different teacher', async () => {
    expect(await countOutstandingPaymentsForStudent(prisma, studentAId, teacherBId)).toBe(1);
  });

  it('returns 0 for a student/teacher pair with no registrations at all', async () => {
    expect(await countOutstandingPaymentsForStudent(prisma, studentBId, teacherBId)).toBe(0);
  });
});

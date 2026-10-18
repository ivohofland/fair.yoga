import { describe, it, expect, beforeAll, afterAll, vi, onTestFinished } from 'vitest';
import { type PrismaClient, type Payment, type PaymentStatus } from '@/lib/prisma-client';
import {
  markPaymentPaid,
  markPaymentOverdue,
  reopenPayment,
  reopenInTransaction,
  markPaymentNotCharged,
  sendPaymentReminder,
  reportPaymentSent,
  withdrawPaymentReport,
  rejectPaymentReport,
  getOutstandingPayments,
  getPaymentsForClass,
  countOutstandingPaymentsForStudent,
  MANUAL_REMIND_COOLDOWN_MS,
  type PaymentOutcome,
  type PaymentRefusal,
} from './payments';
import { hhmmToTime } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';
import { log } from '@/lib/log';
import { createClassFixture } from '../../tests/class-fixtures';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
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

/** How long `blockedBy` polls before it answers false. */
const BLOCK_DEADLINE_MS = 3_000;

/** True once some backend is blocked by `holderPid`; false at the deadline. */
async function blockedBy(holderPid: number): Promise<boolean> {
  const deadline = Date.now() + BLOCK_DEADLINE_MS;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ pid: number }[]>`
      SELECT pid FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
    if (rows.length > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
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
    // not the surname. Both flag choices are load-bearing.
    //
    // Shares the email: with an all-false
    // row, the owning teacher's read and a foreign teacher's read are
    // byte-identical — a row of all-false flags and *no row at all* both
    // project every field to `null`. Verified: with an all-false row the
    // foreign-UUID substitution was still 15/15 green. One released field is
    // what makes "whose row did it read" observable at all.
    //
    // Does not share the surname: a truncated display name is not a fixed
    // point of `formatStudentName`, so it can only appear if the flags were
    // read.
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
    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'manual'), 'applied');

    expect(payment.status).toBe('paid');
    expect(payment.method).toBe('manual');
    expect(payment.paidAt).not.toBeNull();
  });

  it('markPaymentPaid answers unchanged for a payment already paid that way, writing nothing', async () => {
    // Paid with 'manual' by the previous test.
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'manual'), 'unchanged');

    expect(payment.method).toBe('manual');
    expect(payment.paidAt).toEqual(before.paidAt);
    expect(payment.updatedAt).toEqual(before.updatedAt);
  });

  it('markPaymentPaid refuses a payment paid by hand that Mollie then reports paid', async () => {
    expect(refusalCode(await markPaymentPaid(prisma, paymentId, 'mollie'))).toBe('PAYMENT_ALREADY_PAID');

    const row = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(row.method).toBe('manual');
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
    const payment = paymentOf(await markPaymentPaid(prisma, paymentId, 'manual'), 'applied');

    expect(payment.status).toBe('paid');
    expect(payment.method).toBe('manual');
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
    expect(paymentOf(await markPaymentPaid(prisma, paymentId, 'manual'), 'applied').status).toBe('paid');
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

  it('sendPaymentReminder leaves out "Pay your teacher directly" when the teacher has a payment method', async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending', method: null, paidAt: null, reminderSentAt: null },
    });
    await prisma.teacherBankAccount.create({
      data: { teacherId, currency: 'EUR', holderName: 'P. Teacher', iban: 'NL91ABNA0417164300' },
    });
    onTestFinished(async () => {
      await prisma.teacherBankAccount.deleteMany({ where: { teacherId } });
    });

    paymentOf(await sendPaymentReminder(prisma, paymentId), 'applied');

    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notification.body).toMatch(/^€24\.59 for Hatha class on .* at 09:00 is still open\.$/);
  });

  it('sendPaymentReminder leaves out "Pay your teacher directly" when the teacher has a payment link and no bank account', async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending', method: null, paidAt: null, reminderSentAt: null },
    });
    expect(await prisma.teacherBankAccount.count({ where: { teacherId } })).toBe(0);
    await prisma.teacher.update({ where: { id: teacherId }, data: { paymentLink: 'https://paypal.me/payments' } });
    onTestFinished(async () => {
      await prisma.teacher.update({ where: { id: teacherId }, data: { paymentLink: null } });
    });

    paymentOf(await sendPaymentReminder(prisma, paymentId), 'applied');

    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      orderBy: { createdAt: 'desc' },
    });
    expect(notification.body).toMatch(/^€24\.59 for Hatha class on .* at 09:00 is still open\.$/);
  });

  // The class's own currency, not the teacher's: a CHF payment under a EUR
  // teacher with a euro account is reminded in CHF, and told to pay the
  // teacher directly because the teacher holds no CHF account.
  it('sendPaymentReminder words a CHF payment in CHF, with no bank method, under a EUR teacher who has only a euro account', async () => {
    const chf = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Franc Hatha',
      date: new Date('2026-06-02'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      status: 'completed',
      settingsLocked: true,
      currency: 'CHF',
    });
    onTestFinished(async () => {
      await prisma.teacherBankAccount.deleteMany({ where: { teacherId } });
      await prisma.notification.deleteMany({ where: { relatedClassId: chf.id } });
      await prisma.payment.deleteMany({ where: { registration: { classId: chf.id } } });
      await prisma.registration.deleteMany({ where: { classId: chf.id } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: chf.id } } } });
    });
    const registration = await prisma.registration.create({
      data: { classId: chf.id, studentId, status: 'attended', tierAtBooking: 3, price: 24.59, tierRatio: 1.0 },
    });
    const payment = await prisma.payment.create({
      data: { registrationId: registration.id, amount: 24.59, status: 'pending' },
    });
    await prisma.teacherBankAccount.create({
      data: { teacherId, currency: 'EUR', holderName: 'P. Teacher', iban: 'NL91ABNA0417164300' },
    });

    paymentOf(await sendPaymentReminder(prisma, payment.id), 'applied');

    const notification = await prisma.notification.findFirstOrThrow({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder', relatedClassId: chf.id },
    });
    expect(notification.body).toMatch(
      /^CHF 24\.59 for Franc Hatha class on .* at 09:00 is still open\. Pay your teacher directly\.$/,
    );
  });

  /**
   * `teacherId` does two jobs in both queries below — it scopes the `where`,
   * and it selects which `StudentPrivacy` row the projection reads (see
   * `getPaymentsForClass`'s docblock). The tests below cover both: the
   * foreign-teacher reads falsify the `where` scope, and the owning-teacher
   * projection test falsifies the projection argument.
   *
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
   *   releasing the name unconditionally.
   *
   * Neither alone is enough.
   */
  it('projects the student under the OWNING teacher\'s privacy flags', async () => {
    const [outstanding] = await getOutstandingPayments(prisma, teacherId);
    if (!outstanding) throw new Error('expected an outstanding payment');
    expect(outstanding.registration.student.displayName).toBe('PaymentStudent T.');
    expect(outstanding.registration.student.email).toBe(
      `payment-student-${uniqueSuffix}@test.local`,
    );
    // Still per-field: this row shares the email and nothing else.
    expect(outstanding.registration.student.phone).toBeNull();

    const [forClass] = await getPaymentsForClass(prisma, classId, teacherId);
    if (!forClass) throw new Error('expected a payment for the class');
    expect(forClass.registration.student.displayName).toBe('PaymentStudent T.');
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
   * Every test here builds its own payment, so none depends on the state the
   * sequential fixture above left `paymentId` in.
   */
  describe('with a fresh payment per test', () => {
    const fixtureStudentIds: string[] = [];
    let fixtureTag = 0;

    /**
     * A fresh student, a registration for them under `classId`, and a payment
     * on it — claimed by the student when `studentReportedAt` is given.
     */
    async function createPaymentFixture(
      status: PaymentStatus,
      studentReportedAt: Date | null = null,
    ): Promise<{ payment: Payment; studentId: string }> {
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
      const payment = await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: 12.5,
          status,
          ...(status === 'paid' ? { method: 'manual', paidAt: new Date() } : {}),
          ...(status === 'not_charged' ? { notChargedAt: new Date() } : {}),
          studentReportedAt,
        },
      });
      return { payment, studentId: student.id };
    }

    async function makePayment(status: PaymentStatus): Promise<Payment> {
      return (await createPaymentFixture(status)).payment;
    }

    const REPORTED_AT = new Date('2026-06-02T10:00:00Z');

    /** A payment its own student has marked as sent. */
    function makeClaimedPayment(status: PaymentStatus): Promise<{ payment: Payment; studentId: string }> {
      return createPaymentFixture(status, REPORTED_AT);
    }

    /** The student's `reminder` notifications, read fresh. */
    function remindersFor(studentId: string) {
      return prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      });
    }

    /** The message a refused outcome carries; throws, naming the outcome, otherwise. */
    function refusalMessage(outcome: PaymentOutcome): string {
      if (outcome.kind !== 'refused') {
        throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
      }
      return outcome.refusal.message;
    }

    /**
     * A payment like `makePayment`, for a student already linked to the
     * fixture teacher (`teacherId`, the outer fixture) — archived or not —
     * so a test can assert `reopenPayment`'s effect on that link.
     */
    async function makePaymentWithLink(
      status: PaymentStatus,
      isArchived: boolean,
    ): Promise<{ payment: Payment; studentId: string }> {
      const { payment, studentId } = await createPaymentFixture(status);
      await prisma.teacherStudent.create({ data: { teacherId, studentId, isArchived } });
      return { payment, studentId };
    }

    /** The fixture teacher's link to this student, read fresh. */
    async function readLink(studentId: string) {
      return prisma.teacherStudent.findUniqueOrThrow({
        where: { teacherId_studentId: { teacherId, studentId } },
      });
    }

    afterAll(async () => {
      // Nested `afterAll`s run before their parent's, and Registration and
      // Payment both cascade off Student, so this is the whole cleanup.
      // TeacherStudent cascades off Student too, so `makePaymentWithLink`'s
      // link rows need no cleanup of their own.
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
        expect(refusalCode(await markPaymentPaid(prisma, payment.id, 'manual'))).toBe('PAYMENT_WAIVED');
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

      it('un-archives a not_charged payment\'s student link', async () => {
        const { payment, studentId } = await makePaymentWithLink('not_charged', true);
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        expect((await readLink(studentId)).isArchived).toBe(false);
      });

      it('un-archives a paid payment\'s student link', async () => {
        const { payment, studentId } = await makePaymentWithLink('paid', true);
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        expect((await readLink(studentId)).isArchived).toBe(false);
      });

      it('an already-pending payment with an archived link answers unchanged, leaving the link archived', async () => {
        const { payment, studentId } = await makePaymentWithLink('pending', true);
        paymentOf(await reopenPayment(prisma, payment.id), 'unchanged');
        expect((await readLink(studentId)).isArchived).toBe(true);
      });

      it('applies for a not_charged payment whose student has no link at all, and logs the pair', async () => {
        const info = vi.spyOn(log, 'info');
        onTestFinished(() => info.mockRestore());
        const { payment, studentId } = await createPaymentFixture('not_charged');
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        expect(info).toHaveBeenCalledWith(
          { paymentId: payment.id, teacherId, studentId },
          expect.any(String),
        );
      });

      describe('of a payment Mollie settled (Decision 17)', () => {
        let attemptTag = 0;
        function attemptOn(paymentId: string, over: { settledPayment: boolean; chargedBackAt?: Date | null }) {
          return prisma.processorPayment.create({
            data: {
              paymentId, connectionId: null, processorPaymentId: `tr_reopen${uniqueSuffix}${attemptTag++}`, profileId: 'pfl_reopen',
              testmode: true, method: 'ideal', status: 'paid', amount: 12.5, currency: 'EUR', paidAt: new Date(), ...over,
            },
          });
        }
        async function settledByMollie() {
          const payment = await makePayment('paid');
          await prisma.payment.update({ where: { id: payment.id }, data: { method: 'mollie' } });
          return { payment, attempt: await attemptOn(payment.id, { settledPayment: true }) };
        }

        it('is refused PAYMENT_SETTLED_BY_PROCESSOR, leaving it paid and its attempt settling', async () => {
          const { payment, attempt } = await settledByMollie();
          expect(refusalCode(await reopenPayment(prisma, payment.id))).toBe('PAYMENT_SETTLED_BY_PROCESSOR');
          expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('paid');
          expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(true);
        });

        it('applies after a chargeback released the settling attempt', async () => {
          const payment = await makePayment('paid');
          await attemptOn(payment.id, { settledPayment: false, chargedBackAt: new Date() });
          paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        });

        it('is refused for a refund naming another attempt while one still settles it', async () => {
          const { payment, attempt } = await settledByMollie();
          const duplicate = await attemptOn(payment.id, { settledPayment: false });
          const outcome = await prisma.$transaction((tx) => reopenInTransaction(tx, payment.id, { refundAttemptId: duplicate.id }));
          expect(refusalCode(outcome)).toBe('PAYMENT_SETTLED_BY_PROCESSOR');
          expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('paid');
          expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(true);
        });

        it('applies for the refund that names its attempt, releasing that attempt', async () => {
          const { payment, attempt } = await settledByMollie();
          const outcome = await prisma.$transaction((tx) => reopenInTransaction(tx, payment.id, { refundAttemptId: attempt.id }));
          expect(paymentOf(outcome, 'applied')).toMatchObject({ status: 'pending', method: null, paidAt: null });
          expect((await prisma.processorPayment.findUniqueOrThrow({ where: { id: attempt.id } })).settledPayment).toBe(false);
        });
      });

      it('logs nothing for a reopen whose student is linked', async () => {
        const info = vi.spyOn(log, 'info');
        onTestFinished(() => info.mockRestore());
        const { payment } = await makePaymentWithLink('not_charged', false);
        paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        expect(info).not.toHaveBeenCalledWith(
          expect.objectContaining({ paymentId: payment.id }),
          expect.any(String),
        );
      });
    });

    describe('getOutstandingPayments order', () => {
      it('puts a payment whose Mollie payment is processing with the claimed ones, and ships its attempts', async () => {
        const plain = await makePayment('pending');
        const moving = await makePayment('pending');
        await prisma.processorPayment.create({
          data: {
            paymentId: moving.id, connectionId: null, processorPaymentId: `tr_order${uniqueSuffix}`, profileId: 'pfl_order',
            testmode: true, method: 'ideal', status: 'pending', amount: 12.5, currency: 'EUR',
          },
        });
        const { payment: claimed } = await makeClaimedPayment('pending');
        const ours = new Set([plain.id, moving.id, claimed.id]);

        const rows = (await getOutstandingPayments(prisma, teacherId)).filter((r) => ours.has(r.id));

        expect(rows.map((r) => r.id).slice(0, 2).sort()).toEqual([moving.id, claimed.id].sort());
        expect(rows[2]!.id).toBe(plain.id);
        expect(rows.find((r) => r.id === plain.id)!.processorAttempts).toEqual([]);
        expect(rows.find((r) => r.id === moving.id)!.processorAttempts).toEqual([
          expect.objectContaining({ method: 'ideal', status: 'pending', settledPayment: false, chargedBackAt: null, currency: 'EUR', refunds: [] }),
        ]);
      });

      it('getPaymentsForClass ships each payment’s attempts with their refunds', async () => {
        const payment = await makePayment('paid');
        const attempt = await prisma.processorPayment.create({
          data: {
            paymentId: payment.id, connectionId: null, processorPaymentId: `tr_class${uniqueSuffix}`, profileId: 'pfl_order',
            testmode: true, method: 'ideal', status: 'paid', amount: 12.5, currency: 'EUR', settledPayment: true,
          },
        });
        await prisma.processorRefund.create({ data: { attemptId: attempt.id, amount: 12.5, status: 'queued', outcome: 'waived' } });

        const rows = await getPaymentsForClass(prisma, classId, teacherId);

        expect(rows.find((r) => r.id === payment.id)!.processorAttempts).toEqual([
          expect.objectContaining({ id: attempt.id, status: 'paid', settledPayment: true, refunds: [{ status: 'queued' }] }),
        ]);
      });
    });

    describe('reportPaymentSent', () => {
      it.each(['pending', 'overdue'] as const)('stamps an outstanding (%s) payment as reported by its student', async (status) => {
        const { payment, studentId } = await createPaymentFixture(status);
        const row = paymentOf(await reportPaymentSent(prisma, payment.id, studentId), 'applied');
        expect(row.status).toBe(status);
        expect(row.studentReportedAt).not.toBeNull();
      });

      it('answers a payment already reported unchanged, writing nothing', async () => {
        const { payment, studentId } = await makeClaimedPayment('overdue');
        const row = paymentOf(await reportPaymentSent(prisma, payment.id, studentId), 'unchanged');
        expect(row.studentReportedAt).toEqual(REPORTED_AT);
        expect(row.updatedAt).toEqual(payment.updatedAt);
      });

      it.each([
        ['unclaimed', null],
        ['claimed', REPORTED_AT],
      ] as const)('refuses a paid, %s payment with PAYMENT_ALREADY_PAID', async (_label, reportedAt) => {
        const { payment, studentId } = await createPaymentFixture('paid', reportedAt);
        const outcome = await reportPaymentSent(prisma, payment.id, studentId);
        expect(refusalCode(outcome)).toBe('PAYMENT_ALREADY_PAID');
        expect(refusalMessage(outcome)).toBe('Your teacher has already marked this payment as received.');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.studentReportedAt).toEqual(reportedAt);
      });

      it('refuses a not-charged payment with PAYMENT_WAIVED, writing nothing', async () => {
        const { payment, studentId } = await createPaymentFixture('not_charged');
        const outcome = await reportPaymentSent(prisma, payment.id, studentId);
        expect(refusalCode(outcome)).toBe('PAYMENT_WAIVED');
        expect(refusalMessage(outcome)).toBe("Your teacher isn't charging for this class.");
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.studentReportedAt).toBeNull();
      });

      it.each(['pending', 'overdue', 'paid', 'not_charged'] as const)(
        "answers NOT_FOUND for another student's %s payment, writing nothing",
        async (status) => {
          const { payment } = await createPaymentFixture(status);
          // `studentId` (the outer fixture) is a different student.
          const outcome = await reportPaymentSent(prisma, payment.id, studentId);
          expect(refusalCode(outcome)).toBe('NOT_FOUND');
          expect(refusalMessage(outcome)).toBe('This payment no longer exists.');
          const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
          expect(row.studentReportedAt).toBeNull();
          expect(row.updatedAt).toEqual(payment.updatedAt);
        },
      );

      it("answers NOT_FOUND for another student's already-reported payment", async () => {
        const { payment } = await makeClaimedPayment('pending');
        expect(refusalCode(await reportPaymentSent(prisma, payment.id, studentId))).toBe('NOT_FOUND');
      });

      it('a claim withdrawn between the swap and the re-read → CONCURRENT_MODIFICATION', async () => {
        const { payment, studentId } = await makeClaimedPayment('pending');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({ where: { id: payment.id }, data: { studentReportedAt: null } }),
        );

        const outcome = await reportPaymentSent(racing.db, payment.id, studentId);

        expect(racing.fired()).toBe(true);
        expect(refusalCode(outcome)).toBe('CONCURRENT_MODIFICATION');
        expect(refusalMessage(outcome)).toBe('This payment just changed. Reload the page and try again.');
      });
    });

    describe('withdrawPaymentReport', () => {
      it.each(['pending', 'overdue'] as const)("clears an outstanding (%s) payment's claim", async (status) => {
        const { payment, studentId } = await makeClaimedPayment(status);
        const row = paymentOf(await withdrawPaymentReport(prisma, payment.id, studentId), 'applied');
        expect(row.status).toBe(status);
        expect(row.studentReportedAt).toBeNull();
      });

      it('answers an unclaimed outstanding payment unchanged, writing nothing', async () => {
        const { payment, studentId } = await createPaymentFixture('pending');
        const row = paymentOf(await withdrawPaymentReport(prisma, payment.id, studentId), 'unchanged');
        expect(row.studentReportedAt).toBeNull();
        expect(row.updatedAt).toEqual(payment.updatedAt);
      });

      it('refuses a paid payment with PAYMENT_ALREADY_PAID, keeping the claim', async () => {
        const { payment, studentId } = await makeClaimedPayment('paid');
        const outcome = await withdrawPaymentReport(prisma, payment.id, studentId);
        expect(refusalCode(outcome)).toBe('PAYMENT_ALREADY_PAID');
        expect(refusalMessage(outcome)).toBe('Your teacher has already marked this payment as received.');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.studentReportedAt).toEqual(REPORTED_AT);
      });

      it('refuses a not-charged payment with PAYMENT_WAIVED', async () => {
        const { payment, studentId } = await createPaymentFixture('not_charged');
        const outcome = await withdrawPaymentReport(prisma, payment.id, studentId);
        expect(refusalCode(outcome)).toBe('PAYMENT_WAIVED');
        expect(refusalMessage(outcome)).toBe("Your teacher isn't charging for this class.");
      });

      it.each(['pending', 'overdue', 'paid', 'not_charged'] as const)(
        "answers NOT_FOUND for another student's claimed %s payment, writing nothing",
        async (status) => {
          const { payment } = await makeClaimedPayment(status);
          const outcome = await withdrawPaymentReport(prisma, payment.id, studentId);
          expect(refusalCode(outcome)).toBe('NOT_FOUND');
          const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
          expect(row.studentReportedAt).toEqual(REPORTED_AT);
          expect(row.updatedAt).toEqual(payment.updatedAt);
        },
      );

      it('a claim made between the swap and the re-read → CONCURRENT_MODIFICATION', async () => {
        const { payment, studentId } = await createPaymentFixture('pending');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({ where: { id: payment.id }, data: { studentReportedAt: new Date() } }),
        );

        const outcome = await withdrawPaymentReport(racing.db, payment.id, studentId);

        expect(racing.fired()).toBe(true);
        expect(refusalCode(outcome)).toBe('CONCURRENT_MODIFICATION');
        expect(refusalMessage(outcome)).toBe('This payment just changed. Reload the page and try again.');
      });
    });

    describe('rejectPaymentReport', () => {
      it.each(['pending', 'overdue'] as const)(
        "clears an outstanding (%s) payment's claim, stamps reminderSentAt and sends one reminder",
        async (status) => {
          const { payment, studentId } = await makeClaimedPayment(status);

          const row = paymentOf(await rejectPaymentReport(prisma, payment.id), 'applied');

          expect(row.status).toBe(status);
          expect(row.studentReportedAt).toBeNull();
          expect(row.reminderSentAt).not.toBeNull();
          const reminders = await remindersFor(studentId);
          expect(reminders).toHaveLength(1);
          expect(reminders[0]).toMatchObject({
            title: 'Payment not seen yet',
            body:
              `Payment hasn't seen your payment of €12.50 for Hatha class on ${formatDayHeader(new Date('2026-06-01'))} at 09:00 arrive yet. ` +
              "If you've sent it, it may still be on its way.",
            relatedClassId: classId,
          });
        },
      );

      it('answers an unclaimed outstanding payment unchanged, stamping and sending nothing', async () => {
        const { payment, studentId } = await createPaymentFixture('overdue');
        const row = paymentOf(await rejectPaymentReport(prisma, payment.id), 'unchanged');
        expect(row.reminderSentAt).toBeNull();
        expect(row.updatedAt).toEqual(payment.updatedAt);
        expect(await remindersFor(studentId)).toHaveLength(0);
      });

      it('refuses a paid payment with PAYMENT_ALREADY_PAID, keeping the claim', async () => {
        const { payment, studentId } = await makeClaimedPayment('paid');
        expect(refusalCode(await rejectPaymentReport(prisma, payment.id))).toBe('PAYMENT_ALREADY_PAID');
        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.studentReportedAt).toEqual(REPORTED_AT);
        expect(await remindersFor(studentId)).toHaveLength(0);
      });

      it('refuses a not-charged payment with PAYMENT_WAIVED', async () => {
        const { payment, studentId } = await createPaymentFixture('not_charged');
        expect(refusalCode(await rejectPaymentReport(prisma, payment.id))).toBe('PAYMENT_WAIVED');
        expect(await remindersFor(studentId)).toHaveLength(0);
      });

      it('refuses while payments are paused, writing nothing', async () => {
        await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: new Date() } });
        onTestFinished(async () => {
          await prisma.teacher.update({ where: { id: teacherId }, data: { paymentsPausedAt: null } });
        });
        const { payment, studentId } = await makeClaimedPayment('overdue');

        const outcome = await rejectPaymentReport(prisma, payment.id);
        expect(refusalCode(outcome)).toBe('PAYMENTS_PAUSED');
        expect(outcome.kind === 'refused' && outcome.refusal.message).toBe(
          "Payments are paused, so your students are holding off. Resume payments before telling a student their payment hasn't arrived.",
        );

        const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
        expect(row.studentReportedAt).toEqual(REPORTED_AT);
        expect(row.reminderSentAt).toBeNull();
        expect(await remindersFor(studentId)).toHaveLength(0);
      });

      it('a claim made between the swap and the re-read → CONCURRENT_MODIFICATION', async () => {
        const { payment, studentId } = await createPaymentFixture('pending');
        const racing = interposeAfterPaymentWrite(() =>
          prisma.payment.update({ where: { id: payment.id }, data: { studentReportedAt: new Date() } }),
        );

        const outcome = await rejectPaymentReport(racing.db, payment.id);

        expect(racing.fired()).toBe(true);
        expect(refusalCode(outcome)).toBe('CONCURRENT_MODIFICATION');
        expect(await remindersFor(studentId)).toHaveLength(0);
      });
    });

    describe('what the teacher transitions do to a claim', () => {
      it('markPaymentNotCharged clears it', async () => {
        const { payment } = await makeClaimedPayment('overdue');
        const row = paymentOf(await markPaymentNotCharged(prisma, payment.id), 'applied');
        expect(row.studentReportedAt).toBeNull();
      });

      it('markPaymentPaid keeps it', async () => {
        const { payment } = await makeClaimedPayment('pending');
        const row = paymentOf(await markPaymentPaid(prisma, payment.id, 'manual'), 'applied');
        expect(row.studentReportedAt).toEqual(REPORTED_AT);
      });

      it('reopenPayment keeps it', async () => {
        const { payment } = await makeClaimedPayment('paid');
        const row = paymentOf(await reopenPayment(prisma, payment.id), 'applied');
        expect(row.status).toBe('pending');
        expect(row.studentReportedAt).toEqual(REPORTED_AT);
      });

      it('sendPaymentReminder still reminds a claimed payment and keeps the claim', async () => {
        const { payment, studentId } = await makeClaimedPayment('overdue');
        const row = paymentOf(await sendPaymentReminder(prisma, payment.id), 'applied');
        expect(row.reminderSentAt).not.toBeNull();
        expect(row.studentReportedAt).toEqual(REPORTED_AT);
        expect(await remindersFor(studentId)).toHaveLength(1);
      });
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

        const result = await markPaymentPaid(racing.db, payment.id, 'manual');

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

      // The reopen holds the payment's row lock from before its compare-and-
      // swap, so a settle cannot land between the swap and the re-read: it
      // waits on the reopen's backend, and the reopen answers what the row
      // held when it looked.
      it('reopenInTransaction: a settle racing the swap waits on the reopen, which answers unchanged', { timeout: 20_000 }, async () => {
        const payment = await makePayment('pending');
        let settling: Promise<unknown> = Promise.resolve();
        let waited = false;

        const outcome = await prisma.$transaction(async (tx) => {
          const hooked = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop !== 'payment') return Reflect.get(target, prop, receiver) as unknown;
              return new Proxy(target.payment, {
                get(delegate, method, r) {
                  if (method !== 'updateMany') return Reflect.get(delegate, method, r) as unknown;
                  return async (args: Parameters<typeof delegate.updateMany>[0]) => {
                    const swapped = await delegate.updateMany(args);
                    const [holder] = await target.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
                    // `.then` starts the query; a Prisma query left un-awaited never runs.
                    settling = prisma.payment
                      .update({ where: { id: payment.id }, data: { status: 'paid', method: 'manual', paidAt: new Date() } })
                      .then((row) => row);
                    waited = await blockedBy(holder!.pid);
                    return swapped;
                  };
                },
              });
            },
          });
          return reopenInTransaction(hooked, payment.id);
        }, { timeout: 15_000 });
        await settling;

        expect(waited, "the settle never waited on the reopen's payment lock").toBe(true);
        expect(paymentOf(outcome, 'unchanged').status).toBe('pending');
        expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('paid');
      });
    });
  });

  /** What each function answers when the payment id names no row. */
  describe('a payment that does not exist', () => {
    const UNKNOWN_PAYMENT_ID = '00000000-0000-4000-8000-000000000000';

    it.each([
      ['markPaymentPaid', () => markPaymentPaid(prisma, UNKNOWN_PAYMENT_ID, 'manual')],
      ['markPaymentNotCharged', () => markPaymentNotCharged(prisma, UNKNOWN_PAYMENT_ID)],
      ['reopenPayment', () => reopenPayment(prisma, UNKNOWN_PAYMENT_ID)],
      ['sendPaymentReminder', () => sendPaymentReminder(prisma, UNKNOWN_PAYMENT_ID)],
      ['reportPaymentSent', () => reportPaymentSent(prisma, UNKNOWN_PAYMENT_ID, UNKNOWN_PAYMENT_ID)],
      ['withdrawPaymentReport', () => withdrawPaymentReport(prisma, UNKNOWN_PAYMENT_ID, UNKNOWN_PAYMENT_ID)],
      ['rejectPaymentReport', () => rejectPaymentReport(prisma, UNKNOWN_PAYMENT_ID)],
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

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, PROJECTED_STUDENT_KEYS } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';
import { MANUAL_REMIND_COOLDOWN_MS } from '@/services/payments';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherToken: string;
let otherTeacherToken: string;

let teacherId: string;
let otherTeacherId: string;
let roomId: string;
let studentId: string;
let studentAccountId: string;
let classId: string;
let paymentId: string;

async function makeTeacher(tag: string): Promise<{ id: string; token: string }> {
  const email = `pay-${tag}-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Pay',
      lastName: tag,
      email,
      account: { create: { email } },
      bio: 'Teacher for payment API tests',
      pageSlug: `pay-${tag}-${suffix}`,
    },
  });
  const token = await seedSession(prisma, teacher.accountId);
  return { id: teacher.id, token };
}

beforeAll(async () => {
  await prisma.$connect();
  const owner = await makeTeacher('owner');
  teacherId = owner.id;
  teacherToken = owner.token;
  const other = await makeTeacher('other');
  otherTeacherId = other.id;
  otherTeacherToken = other.token;

  const room = await prisma.room.create({
    data: {
      venueName: 'Payment Venue',
      address: `${suffix} Payment St`,
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

  const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Reminder Flow',
      date: new Date('2099-06-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 15,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 8,
      status: 'completed',
    });
  classId = cls.id;

  const studentEmail = `pay-student-${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Reminder',
      lastName: 'Student',
      email: studentEmail,
      incomeTier: 3,
      // Claimed, deliberately. Every privacy gate has an `isUnclaimed ||`
      // bypass, so an unclaimed fixture would make any assertion added here
      // pass whether or not the gate works. See #167.
      claimedAt: new Date(),
      account: { create: { email: studentEmail } },
    },
  });
  studentId = student.id;
  studentAccountId = student.accountId!;

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
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
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
  await prisma.account.deleteMany({ where: { id: studentAccountId } });
  await prisma.$disconnect();
});

/** A plain ownership refusal: 403, with no `unchanged` outcome riding along. */
async function expectForbidden(res: Response): Promise<void> {
  const body = (await res.json()) as { outcome?: unknown };
  expect({ status: res.status, outcome: body.outcome }).toEqual({ status: 403, outcome: undefined });
}

describe('GET /api/payments, /api/payments/[id], /api/classes/[id]/payments', () => {
  it('GET /api/payments withholds the email and surname of a student who shared neither', async () => {
    const res = await fetch(`${BASE_URL}/api/payments`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        registration: {
          student: Record<string, unknown> & { displayName: string; email: string | null };
          tierAtBooking?: number;
          tierRatio?: number;
          price?: number;
        };
      }[];
    };
    const row = body.data.find((p) => p.registration.student.displayName?.startsWith('Reminder'));
    expect(row).toBeDefined();
    expect(row!.registration.student.displayName).toBe('Reminder s.');
    expect(row!.registration.student.email).toBeNull();
    // The key set, not just the values — see PROJECTED_STUDENT_KEYS. This
    // route reads `services/payments.ts`'s `getOutstandingPayments`, where the
    // `{ ...student, ...projectStudentForTeacher(student, t) }` spread left
    // this file 22/22 green while shipping the raw surname beside the
    // truncated one.
    expect(Object.keys(row!.registration.student).sort()).toEqual(PROJECTED_STUDENT_KEYS);
    expect(row!.registration.tierAtBooking).toBeUndefined();
    expect(row!.registration.tierRatio).toBeUndefined();
    expect(row!.registration.price).toBeUndefined();
  });

  it('GET /api/payments/[id] applies the same gate as the list', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        registration: {
          student: Record<string, unknown> & { displayName: string; email: string | null };
          tierAtBooking?: number;
          tierRatio?: number;
          price?: number;
        };
      };
    };
    expect(body.data.registration.student.displayName).toBe('Reminder s.');
    expect(body.data.registration.student.email).toBeNull();
    // This route projects inline (`api/payments/[id]/route.ts`) rather than
    // through the service, so it needs its own key-set assertion.
    expect(Object.keys(body.data.registration.student).sort()).toEqual(PROJECTED_STUDENT_KEYS);
    expect(body.data.registration.tierAtBooking).toBeUndefined();
    expect(body.data.registration.tierRatio).toBeUndefined();
    expect(body.data.registration.price).toBeUndefined();
  });

  it("GET /api/payments/[id] 403s another teacher's payment", async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}`, {
      headers: cookie(otherTeacherToken),
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/payments/[id] 404s an unknown payment with NOT_FOUND', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/00000000-0000-4000-8000-000000000000`, {
      headers: cookie(teacherToken),
    });
    await expectRefusal(res, 'NOT_FOUND');
  });

  it('GET /api/classes/[id]/payments withholds the surname too', async () => {
    const res = await fetch(`${BASE_URL}/api/classes/${classId}/payments`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        registration: {
          student: Record<string, unknown> & { displayName: string; email: string | null };
          tierAtBooking?: number;
          tierRatio?: number;
          price?: number;
        };
      }[];
    };
    expect(body.data[0]!.registration.student.displayName).toBe('Reminder s.');
    // Was missing, unlike both siblings above: this test asserted the name and
    // nothing about the email, so half the gate went unpinned on this route.
    expect(body.data[0]!.registration.student.email).toBeNull();
    // Reads `getPaymentsForClass` — the second of the two service call sites
    // the spread regression hits.
    expect(Object.keys(body.data[0]!.registration.student).sort()).toEqual(
      PROJECTED_STUDENT_KEYS,
    );
    expect(body.data[0]!.registration.tierAtBooking).toBeUndefined();
    expect(body.data[0]!.registration.tierRatio).toBeUndefined();
    expect(body.data[0]!.registration.price).toBeUndefined();
  });

  it("GET /api/classes/[id]/payments 403s another teacher's class", async () => {
    const res = await fetch(`${BASE_URL}/api/classes/${classId}/payments`, {
      headers: cookie(otherTeacherToken),
    });
    expect(res.status).toBe(403);
  });

  it('GET /api/classes/[id]/payments 404s an unknown class with NOT_FOUND', async () => {
    const res = await fetch(
      `${BASE_URL}/api/classes/00000000-0000-4000-8000-000000000000/payments`,
      { headers: cookie(teacherToken) },
    );
    await expectRefusal(res, 'NOT_FOUND');
  });
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
    await expectRefusal(res, 'NOT_FOUND');
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
    const data = (await expectApplied(res)) as { reminderSentAt: string | null };
    expect(data.reminderSentAt).not.toBeNull();

    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });
    expect(notification).not.toBeNull();
    expect(notification!.title).toBe('Payment outstanding');

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(stamped.reminderSentAt).not.toBeNull();
  });

  it('answers a retry inside the cooldown unchanged, with the stamp, sending nothing', async () => {
    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    const before = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
    });

    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(teacherToken),
    });
    const data = (await expectUnchanged(res)) as { reminderSentAt: string | null };
    expect(data.reminderSentAt).toBe(stamped.reminderSentAt!.toISOString());

    expect(
      await prisma.notification.count({
        where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      }),
    ).toBe(before);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.reminderSentAt).toEqual(stamped.reminderSentAt);
    expect(after.updatedAt).toEqual(stamped.updatedAt);
  });

  it("403s another teacher's reminder inside the cooldown rather than answering unchanged", async () => {
    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    // Otherwise the unchanged branch this test means to rule out isn't even
    // reachable, and a 403 would pass for the wrong reason.
    expect(Date.now() - stamped.reminderSentAt!.getTime()).toBeLessThan(MANUAL_REMIND_COOLDOWN_MS);

    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
      method: 'POST',
      headers: cookie(otherTeacherToken),
    });
    await expectForbidden(res);
  });

  it('refuses a settled payment inside the cooldown with PAYMENT_SETTLED, sending nothing', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'paid' } });
    try {
      const settled = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
      // Both the settled refusal and the unchanged answer fit this row, which
      // the reminder above stamped moments ago. Settled makes the reminder moot,
      // so it answers.
      expect(Date.now() - settled.reminderSentAt!.getTime()).toBeLessThan(MANUAL_REMIND_COOLDOWN_MS);
      const before = await prisma.notification.count({
        where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      });

      const res = await fetch(`${BASE_URL}/api/payments/${paymentId}/remind`, {
        method: 'POST',
        headers: cookie(teacherToken),
      });
      await expectRefusal(res, 'PAYMENT_SETTLED');

      const after = await prisma.notification.count({
        where: { recipientType: 'student', recipientId: studentId, type: 'reminder' },
      });
      expect(after).toBe(before);
    } finally {
      // Leave the fixture pending for cleanup symmetry — in a `finally` so an
      // assertion failure above (a broken guard) can't leave every describe
      // after this one reading a 'paid' row instead of the 'pending' one they
      // assume.
      await prisma.payment.update({ where: { id: paymentId }, data: { status: 'pending' } });
    }
  });

  describe('is retry-safe against a concurrent duplicate (#196)', () => {
    // Its own student and payment: the assertion is a notification count, and
    // the shared fixture student has already been reminded by the cases above.
    // The registration hangs off the shared class, so the file's `afterAll`
    // sweeps the notifications this block produces.
    let raceStudentId: string;
    let racePaymentId: string;

    beforeAll(async () => {
      const student = await prisma.student.create({
        data: {
          firstName: 'Race',
          lastName: 'Remind',
          email: `pay-race-student-${suffix}@test.local`,
          incomeTier: 3,
        },
        select: { id: true },
      });
      raceStudentId = student.id;
      const registration = await prisma.registration.create({
        data: { classId, studentId: raceStudentId, tierAtBooking: 3, status: 'attended' },
      });
      racePaymentId = (
        await prisma.payment.create({
          data: { registrationId: registration.id, amount: 9.5, status: 'pending' },
        })
      ).id;
    });

    afterAll(async () => {
      // Nested `afterAll`s run before their parent's. Registration and Payment
      // both cascade off Student; the notifications do not, and the parent's
      // `relatedClassId` sweep is what collects them.
      await prisma.student.delete({ where: { id: raceStudentId } });
    });

    it('duns the student once when the same reminder arrives twice at once', async () => {
      // A plain `Promise.all` of two fetches serialises — the second request
      // lands after the first has committed, so the CAS is never the thing
      // that answers it. The deterministic lever (same as the registration
      // cancel race in `registrations-api.test.ts`): a second client holds the
      // payment row locked BEFORE either request runs, so both read `pending`
      // with no stamp (uncommitted state is invisible under READ COMMITTED)
      // and both park on the lock at the `updateMany`.
      const holder = new PrismaClient();
      let release!: () => void;
      let locked!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      // The handshake, without which the lever is decorative: `$transaction`
      // returns before its callback has run, and a fresh `PrismaClient` has
      // to connect and start its engine first (50-200ms, measured), so both
      // requests could finish before the row was ever locked — and the second
      // would then find the first's stamp already committed, never meeting it
      // inside the CAS.
      const parked = new Promise<void>((r) => {
        locked = r;
      });
      const holding = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${racePaymentId} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 20_000 },
      );
      await parked;

      const remind = () =>
        fetch(`${BASE_URL}/api/payments/${racePaymentId}/remind`, {
          method: 'POST',
          headers: cookie(teacherToken),
        });
      const both = Promise.all([remind(), remind()]);

      // Long enough that both requests have read the payment and parked on the
      // holder's lock, short enough not to approach any transaction timeout.
      let settled = false;
      void both.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 1000));

      // The lever is asserted, not assumed: if either request answered before
      // the release, it never met the other inside the CAS, and the pass below
      // would be the scheduler's doing rather than the guard's.
      expect(settled).toBe(false);
      release();
      await holding;
      const [a, b] = await both;
      await holder.$disconnect();

      // Asserted before the outcomes, deliberately: the defect is a student
      // dunned twice for one debt, and this is the assertion whose failure
      // message names it. With the outcomes first, removing the guard fails on
      // a missing `unchanged`, which says nothing about what that cost anyone.
      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: raceStudentId, type: 'reminder' },
      });
      expect(notifications).toHaveLength(1);

      // Either request can win, so the loser is identified rather than assumed:
      // both answer 200, and exactly one says it changed nothing.
      expect([a.status, b.status]).toEqual([200, 200]);
      const bodies = (await Promise.all([a.json(), b.json()])) as {
        data: { reminderSentAt: string };
        outcome?: string;
      }[];
      expect(bodies.map((body) => body.outcome ?? 'applied').sort()).toEqual([
        'applied',
        'unchanged',
      ]);
      // The loser carries the winner's stamp, not one of its own.
      expect(bodies[0]!.data.reminderSentAt).toBe(bodies[1]!.data.reminderSentAt);
    });
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
const notCharged = (token: string | null, id: string) =>
  fetch(`${BASE_URL}/api/payments/${id}/not-charged`, {
    method: 'POST',
    headers: { ...(token ? cookie(token) : {}) },
  });

/** The keys of a payment row on the wire — the applied and unchanged answers carry the same ones. */
const PAYMENT_ROW_KEYS = [
  'amount',
  'createdAt',
  'id',
  'method',
  'notChargedAt',
  'paidAt',
  'processorRef',
  'registrationId',
  'reminderSentAt',
  'status',
  'updatedAt',
];

describe('POST /api/payments/[id]/paid', () => {
  it('rejects a signed-out caller', async () => {
    const res = await paid(null, paymentId);
    expect(res.status).toBe(401);
  });

  it('404s an unknown payment', async () => {
    const res = await paid(teacherToken, UNKNOWN_PAYMENT_ID);
    await expectRefusal(res, 'NOT_FOUND');
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
    const data = (await expectApplied(res)) as { status: string };
    expect(data.status).toBe('paid');

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(stamped.status).toBe('paid');
    expect(stamped.method).toBe('cash');
    expect(stamped.paidAt).not.toBeNull();
  });

  it('answers the same mark unchanged, writing nothing', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await paid(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as { status: string; method: string | null };
    expect(data).toMatchObject({ status: 'paid', method: 'cash' });

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('paid');
    expect(after.method).toBe('cash');
    expect(after.paidAt).toEqual(before.paidAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("403s another teacher's identical mark rather than answering unchanged", async () => {
    const res = await paid(otherTeacherToken, paymentId);
    await expectForbidden(res);
  });

  it('refuses a mark with another method: PAYMENT_ALREADY_PAID', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await paid(teacherToken, paymentId, { method: 'bank_transfer' });
    await expectRefusal(res, 'PAYMENT_ALREADY_PAID');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.method).toBe('cash');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('refuses a not-charged payment: PAYMENT_WAIVED', async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'not_charged', method: null, paidAt: null, notChargedAt: new Date() },
    });
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await paid(teacherToken, paymentId);
    await expectRefusal(res, 'PAYMENT_WAIVED');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('not_charged');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

describe('POST /api/payments/[id]/unpaid', () => {
  // Self-seeding: this block mutates the shared fixture payment, so don't
  // depend on the /paid block having run.
  beforeAll(async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'paid', method: 'cash', paidAt: new Date(), notChargedAt: null },
    });
  });

  it('rejects a signed-out caller', async () => {
    const res = await unpaid(null, paymentId);
    expect(res.status).toBe(401);
  });

  it('404s an unknown payment', async () => {
    const res = await unpaid(teacherToken, UNKNOWN_PAYMENT_ID);
    await expectRefusal(res, 'NOT_FOUND');
  });

  it("403s another teacher's payment (unpaid)", async () => {
    const res = await unpaid(otherTeacherToken, paymentId);
    expect(res.status).toBe(403);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('paid');
  });

  it('undoes the paid payment back to pending', async () => {
    const res = await unpaid(teacherToken, paymentId);
    const data = (await expectApplied(res)) as { status: string };
    expect(data.status).toBe('pending');

    const reverted = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(reverted.status).toBe('pending');
  });

  it('answers an undo of a pending payment unchanged, writing nothing', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await unpaid(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as { status: string };
    expect(data.status).toBe('pending');

    // Read BEFORE any restore: an unchanged answer must have written nothing.
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('pending');
    expect(after.method).toBeNull();
    expect(after.paidAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('answers an undo of an overdue payment unchanged, carrying its status', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'overdue' } });
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await unpaid(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as { status: string };
    expect(data.status).toBe('overdue');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('overdue');
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("403s another teacher's undo of an unpaid payment rather than answering unchanged", async () => {
    const res = await unpaid(otherTeacherToken, paymentId);
    await expectForbidden(res);
  });
});

describe('POST /api/payments/[id]/not-charged', () => {
  // Self-seeding: this block mutates the shared fixture payment, so don't
  // depend on the /paid or /unpaid blocks having run.
  beforeAll(async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'pending', method: null, paidAt: null, notChargedAt: null },
    });
  });

  it('rejects a signed-out caller', async () => {
    const res = await notCharged(null, paymentId);
    expect(res.status).toBe(401);
  });

  it('404s an unknown payment', async () => {
    const res = await notCharged(teacherToken, UNKNOWN_PAYMENT_ID);
    await expectRefusal(res, 'NOT_FOUND');
  });

  it("403s another teacher's payment", async () => {
    const res = await notCharged(otherTeacherToken, paymentId);
    expect(res.status).toBe(403);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('pending');
  });

  it('marks a payment not charged', async () => {
    const res = await notCharged(teacherToken, paymentId);
    const data = (await expectApplied(res)) as Record<string, unknown>;
    expect(data.status).toBe('not_charged');
    // Denies every key not on `PAYMENT_ROW_KEYS`, so a widened `select` here
    // fails this assertion.
    expect(Object.keys(data).sort()).toEqual(PAYMENT_ROW_KEYS);

    const stamped = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(stamped.status).toBe('not_charged');
    expect(stamped.notChargedAt).not.toBeNull();
  });

  it('answers a payment already not charged unchanged, writing nothing', async () => {
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await notCharged(teacherToken, paymentId);
    const data = (await expectUnchanged(res)) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(PAYMENT_ROW_KEYS);
    expect(data.status).toBe('not_charged');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('not_charged');
    expect(after.notChargedAt).toEqual(before.notChargedAt);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("403s another teacher's mark on a payment already not charged rather than answering unchanged", async () => {
    const res = await notCharged(otherTeacherToken, paymentId);
    await expectForbidden(res);

    const unchanged = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(unchanged.status).toBe('not_charged');
  });

  it('reverses a not-charged payment through /unpaid', async () => {
    const res = await unpaid(teacherToken, paymentId);
    const data = (await expectApplied(res)) as { status: string };
    expect(data.status).toBe('pending');

    const reverted = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(reverted.status).toBe('pending');
    expect(reverted.notChargedAt).toBeNull();
  });

  it('refuses a paid payment: PAYMENT_ALREADY_PAID', async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'paid', method: 'cash', paidAt: new Date() },
    });
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });

    const res = await notCharged(teacherToken, paymentId);
    await expectRefusal(res, 'PAYMENT_ALREADY_PAID');

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(after.status).toBe('paid');
    expect(after.notChargedAt).toBeNull();
    expect(after.updatedAt).toEqual(before.updatedAt);
  });
});

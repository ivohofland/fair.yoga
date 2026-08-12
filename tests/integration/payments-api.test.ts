import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, PROJECTED_STUDENT_KEYS } from '../helpers';

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
  await prisma.account.deleteMany({ where: { id: studentAccountId } });
  await prisma.$disconnect();
});

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

  it('GET /api/classes/[id]/payments 404s an unknown class', async () => {
    const res = await fetch(
      `${BASE_URL}/api/classes/00000000-0000-4000-8000-000000000000/payments`,
      { headers: cookie(teacherToken) },
    );
    expect(res.status).toBe(404);
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
      // would then 409 off its own pre-check rather than off the CAS.
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

      // Asserted before the status pair, deliberately: the defect is a student
      // dunned twice for one debt, and this is the assertion whose failure
      // message names it. With the statuses first, removing the guard fails on
      // `[200, 200]`, which reports two successful requests without saying
      // what that cost anyone.
      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: raceStudentId, type: 'reminder' },
      });
      expect(notifications).toHaveLength(1);

      // Either request can win, so the loser is identified rather than assumed.
      expect([a.status, b.status].sort()).toEqual([200, 409]);
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

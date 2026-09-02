import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { PaymentStatus } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

// React's SSR splices `<!-- -->` around a dynamic text node that sits beside
// a static one — `€{outstandingTotal.toFixed(2)}` and `{outstanding.length}
// {…}` are exactly that shape, so the raw HTML reads `€<!-- -->12.00` and
// `1<!-- --> <!-- -->payment`. A plain `toContain` fails against correct
// output; stripping the markers asserts on what a reader sees. Same
// convention as `waitlist-display.test.ts`'s `normalise`.
function normalise(html: string): string {
  return html.replaceAll('<!-- -->', '');
}

/**
 * `/settings/payments` — the payments overview's three filters.
 *
 * Before this task the outstanding total and its caption read
 * `p.status !== 'paid'`, which counts a `not_charged` payment as still owed,
 * and the received total re-filtered `=== 'paid'` from the full list rather
 * than reusing the tile's own `outstanding`/`received` split. Both totals now
 * read positively — `isOutstanding` for the owed side, `=== 'paid'` for the
 * received side — and a third section renders `not_charged` payments on
 * their own, out of both totals.
 */
describe('GET /settings/payments — positive filters and the not-charged section', () => {
  let teacherId = '';
  let teacherAccountId = '';
  let teacherToken = '';
  let roomId = '';
  const studentIds: string[] = [];
  const studentAccountIds: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `payments-overview-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Payments',
        lastName: 'Teacher',
        email: teacherEmail,
        bio: 'Payments overview fixture teacher',
        pageSlug: `payments-overview-teacher-${suffix}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    teacherToken = await seedSession(prisma, teacherAccountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Payments Overview Studio',
        address: `${suffix} Payments Overview St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 25 },
    });

    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: `Payments Overview Fixture ${suffix}`,
      date: new Date('2026-06-01T00:00:00.000Z'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
    });

    async function seedPayment(tag: string, status: PaymentStatus, amount: number) {
      const email = `payments-overview-${tag}-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName: 'Overview',
          lastName: tag,
          email,
          claimedAt: new Date(),
          account: { create: { email } },
        },
        select: { id: true, accountId: true },
      });
      studentIds.push(student.id);
      studentAccountIds.push(student.accountId as string);

      const registration = await prisma.registration.create({
        data: { classId: cls.id, studentId: student.id, status: 'attended', tierAtBooking: 2 },
      });

      await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount,
          status,
          ...(status === 'paid' ? { paidAt: new Date() } : {}),
          ...(status === 'not_charged' ? { notChargedAt: new Date() } : {}),
        },
      });
    }

    await seedPayment('paid', 'paid', 20);
    await seedPayment('pending', 'pending', 12);
    await seedPayment('notcharged', 'not_charged', 15);

    // Warm the route: `next dev` compiles a page lazily on its first request,
    // and that compile time can otherwise read as a test failure.
    await fetch(`${BASE_URL}/settings/payments`, { headers: cookie(teacherToken) }).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { registration: { studentId: { in: studentIds } } } });
    await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, ...studentAccountIds] } },
    });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, ...studentAccountIds] } },
    });
    await prisma.$disconnect();
  });

  it('keeps not-charged money out of both totals and gives it its own section', async () => {
    const res = await fetch(`${BASE_URL}/settings/payments`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const html = normalise(await res.text());

    expect(html).toContain('€12.00'); // Outstanding total — not 27.00
    expect(html).not.toContain('€27.00');
    expect(html).toContain('€20.00'); // Received total — not 35.00
    expect(html).not.toContain('€35.00');
    expect(html).toContain('Not charged'); // the third section heading
    expect(html).toContain('⊘ Not charged');
  });

  it('counts only outstanding payments in the outstanding caption', async () => {
    const res = await fetch(`${BASE_URL}/settings/payments`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const html = normalise(await res.text());

    expect(html).toContain('1 payment');
    expect(html).not.toContain('2 payments');
  });
});

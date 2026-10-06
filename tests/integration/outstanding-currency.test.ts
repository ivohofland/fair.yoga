import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/** Strips React's text-node markers and the flight payload's string escapes. */
function normalise(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('\\"', '"');
}

/**
 * The two outstanding-payment sums outside reporting (#758): the payments
 * overview's Outstanding card and the student detail page's archive offer
 * (`ArchiveStudentButton`'s `outstanding.totals`). A teacher owed money in two
 * currencies sees one line per currency, never their sum.
 *
 * Fixture: one student owes €12.00 and €8.00 (two EUR classes) and £7.00 (one
 * GBP class). Per-row amounts never read €20.00, so that string comes only
 * from a total; 27.00 is the cross-currency sum.
 */
describe('outstanding totals across currencies', () => {
  let teacherId: string | undefined;
  let teacherAccountId: string | undefined;
  let studentId: string | undefined;
  let studentAccountId: string | undefined;
  let roomId: string | undefined;
  let token = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `outcur-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Outstanding',
        lastName: 'Currency',
        email: teacherEmail,
        bio: 'Outstanding currency fixture teacher',
        pageSlug: `outcur-teacher-${suffix}`,
        currency: 'EUR',
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    token = await seedSession(prisma, teacher.accountId);

    const studentEmail = `outcur-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Owes',
        lastName: 'Twice',
        email: studentEmail,
        claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId ?? undefined;
    await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });

    const room = await prisma.room.create({
      data: {
        venueName: 'Outstanding Hall',
        address: `${suffix} Outstanding St`,
        city: 'Amsterdam',
        postcode: '1000OC',
        roomName: 'Main Room',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 10 },
    });

    async function owed(currency: 'EUR' | 'GBP', amount: string, day: number) {
      const cls = await createClassFixture(prisma, {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: `Outstanding ${currency} ${day}`,
        date: new Date(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: new Prisma.Decimal('10.00'),
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 10,
        status: 'completed',
        currency,
      });
      const registration = await prisma.registration.create({
        data: { classId: cls.id, studentId: student.id, status: 'attended', tierAtBooking: 3 },
      });
      await prisma.payment.create({
        data: { registrationId: registration.id, amount: new Prisma.Decimal(amount), status: 'pending' },
      });
    }

    await owed('EUR', '12.00', 10);
    await owed('EUR', '8.00', 11);
    await owed('GBP', '7.00', 12);

    // Warm both routes: `next dev` compiles a page lazily on its first request.
    await fetch(`${BASE_URL}/settings/payments`, { headers: cookie(token) }).catch(() => {});
    await fetch(`${BASE_URL}/students/${student.id}`, { headers: cookie(token) }).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    if (studentId) {
      await prisma.payment.deleteMany({ where: { registration: { studentId } } });
      await prisma.registration.deleteMany({ where: { studentId } });
    }
    if (teacherId) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    }
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    const accountIds = [teacherAccountId, studentAccountId].filter((id): id is string => id !== undefined);
    if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    if (studentId) await prisma.student.deleteMany({ where: { id: studentId } });
    if (teacherId) await prisma.teacher.deleteMany({ where: { id: teacherId } });
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('payments overview: the Outstanding card shows one total per currency, never their sum', async () => {
    const res = await fetch(`${BASE_URL}/settings/payments`, { headers: cookie(token) });
    expect(res.status).toBe(200);
    const html = normalise(await res.text());

    expect(html).toContain('€20.00');
    expect(html).toContain('£7.00');
    expect(html).not.toContain('27.00');
  });

  it('student detail: the archive offer carries one total per currency, never their sum', async () => {
    const res = await fetch(`${BASE_URL}/students/${studentId}`, { headers: cookie(token) });
    expect(res.status).toBe(200);
    const html = normalise(await res.text());

    // Rendered only when the confirm opens, so it is read from the props the
    // server hands `ArchiveStudentButton`.
    expect(html).toContain('"totals":[{"currency":"EUR","cents":2000},{"currency":"GBP","cents":700}]');
    expect(html).not.toContain('"cents":2700');
  });
});

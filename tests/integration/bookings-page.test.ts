import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * `/bookings` — the "How to pay" disclosure's payment-status gate.
 *
 * The disclosure (teacher IBAN, account name, remittance reference, and a
 * scannable EPC QR pre-filled with the amount) used to be gated on `!isPaid`,
 * so a `not_charged` payment — neither paid nor outstanding — fell into the
 * same branch as a genuinely unpaid one and solicited money the teacher had
 * explicitly forgiven. The load-bearing assertion here is the IBAN's absence,
 * not just the state label's presence: the label and the disclosure render
 * from independent conditions, so a test that only checked the label would
 * pass against the unfixed gate too.
 */
describe('GET /bookings (page) — payment status gate', () => {
  const TEACHER_IBAN = 'NL91ABNA0417164300';

  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let roomId = '';
  let paymentId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `bookings-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Bookings',
        lastName: 'Teacher',
        email: teacherEmail,
        bio: 'Bookings page fixture teacher',
        pageSlug: `bookings-teacher-${suffix}`,
        bankIban: TEACHER_IBAN,
        bankAccountName: 'Bookings Teacher',
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Bookings Studio',
        address: `${suffix} Bookings St`,
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

    const studentEmail = `bookings-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Bookings',
        lastName: 'Student',
        email: studentEmail,
        claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: `Bookings Fixture Class ${suffix}`,
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

    const registration = await prisma.registration.create({
      data: {
        classId: cls.id,
        studentId,
        status: 'attended',
        tierAtBooking: 2,
      },
    });

    const payment = await prisma.payment.create({
      data: {
        registrationId: registration.id,
        amount: 18.5,
        status: 'not_charged',
        notChargedAt: new Date(),
      },
    });
    paymentId = payment.id;

    // Warm the route: `next dev` compiles a page lazily on its first request,
    // and that compile time can otherwise read as a test failure.
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { registration: { studentId } } });
    await prisma.registration.deleteMany({ where: { studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('tells a student their payment was not charged, and stops asking for it', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('⊘ Not charged');
    expect(html).not.toContain('How to pay');
    // The load-bearing assertion: a not-charged payment must not solicit
    // payment, and the disclosure carrying the teacher's IBAN is exactly what
    // would do that if the gate were still `!isPaid`.
    expect(html).not.toContain(TEACHER_IBAN);
  });

  it('still shows an unpaid student how to pay', async () => {
    await prisma.payment.update({ where: { id: paymentId }, data: { status: 'pending', notChargedAt: null } });

    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('○ Unpaid');
    expect(html).toContain('How to pay');
    expect(html).toContain(TEACHER_IBAN);
  });
});

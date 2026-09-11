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
 * A `not_charged` payment must not solicit payment: no "How to pay"
 * disclosure, no teacher IBAN, no QR code. An actually-unpaid payment still
 * gets all three. The load-bearing assertion is the IBAN's absence, not just
 * the state label's presence: the label and the disclosure render from
 * independent conditions, so a test that only checked the label would not
 * exercise the disclosure gate at all.
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
    // payment, and the IBAN in the disclosure is the specific thing that
    // would.
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

/**
 * `/bookings` — the Upcoming section's registration-progress count.
 *
 * The progress bar's count must come from active registrations only: a
 * cancelled row must not inflate it. This also covers the price line and
 * "View class" link that Task 3 adds alongside the progress bar.
 */
describe('GET /bookings (page) — upcoming registration count', () => {
  const suffix2 = uniqueSuffix();
  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let cancelledAccountId = '';
  let roomId = '';
  let classId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `bookings-count-teacher-${suffix2}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Count', lastName: 'Teacher', email: teacherEmail,
        bio: 'Count fixture teacher',
        pageSlug: `bookings-count-teacher-${suffix2}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Count Studio',
        address: `${suffix2} Count St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 6, rentalRate: 15 },
    });

    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Count Test Class',
      date: new Date('2099-07-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 40,
      minStudents: 2,
      maxStudents: 6,
      status: 'open',
    });
    classId = cls.id;

    const studentEmail = `bookings-count-student-${suffix2}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Counted', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        incomeTier: 3, tierSelectedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    // The viewer's own booking (counts).
    await prisma.registration.create({
      data: { classId, studentId, tierAtBooking: 3, status: 'registered' },
    });
    // A second student who cancelled — must NOT inflate the progress bar.
    const cancelledEmail = `bookings-count-cancelled-${suffix2}@test.local`;
    const cancelledStudent = await prisma.student.create({
      data: {
        firstName: 'Cancelled', lastName: 'Student', email: cancelledEmail,
        claimedAt: new Date(),
        incomeTier: 2,
        account: { create: { email: cancelledEmail } },
      },
      select: { id: true, accountId: true },
    });
    cancelledAccountId = cancelledStudent.accountId as string;
    await prisma.registration.create({
      data: { classId, studentId: cancelledStudent.id, tierAtBooking: 2, status: 'cancelled' },
    });

    // Warm the route before the assertions score anything (next dev compiles
    // a page lazily on its first hit).
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, studentAccountId, cancelledAccountId] } },
    });
    await prisma.student.deleteMany({ where: { email: { contains: suffix2 } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId, cancelledAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('counts only active registrations, not cancelled ones, in the progress bar', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    // React's SSR HTML inserts `<!-- -->` hydration markers between adjacent
    // JSX expressions — `{min}–{max}` renders as `2<!-- -->–<!-- -->6`, not
    // the contiguous text a naive substring/regex check would expect.
    // Stripping them makes the assertion below robust to that, without
    // hardcoding where React happens to place them.
    const html = (await res.text()).replace(/<!-- -->/g, '');
    // One active registration (the viewer's own) against a min of 2 — the
    // cancelled row must not count toward it. The rendered count is "1"
    // paired with "/ 2–6"; asserting the pair together rules out a
    // coincidental "1" elsewhere in the page.
    expect(html).toMatch(/1[\s\S]{0,80}\/ 2–6/);
  });

  it('shows the price line and a link to the booking page', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    const html = await res.text();
    expect(html).toContain('depending on how many join');
    expect(html).toContain(`/bookings-count-teacher-${suffix2}/book/${classId}`);
  });
});

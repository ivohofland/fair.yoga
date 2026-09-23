import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';
import { formatInstantInZone } from '@/lib/timezone';

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
      effectiveTeacherRate: 10,
      totalStudents: 1,
      totalRevenue: 30,
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
        amount: 30,
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
 * The progress bar's count must come from active registrations only: neither
 * a cancelled row nor a late-cancelled one may inflate it. This also covers
 * the price line and "View class" link this issue adds alongside the
 * progress bar (#433).
 */
describe('GET /bookings (page) — upcoming registration count', () => {
  const suffix2 = uniqueSuffix();
  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let cancelledAccountId = '';
  let lateCancelAccountId = '';
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
    // A third student who cancelled after the deadline — still billed
    // (`late_cancel` is in `CHARGED_STATUSES`, so the Prisma query above
    // returns this row to the page), but it freed its seat and must NOT
    // inflate the progress bar either. Unlike the plain `cancelled` row
    // above, this one is the only fixture member that actually reaches the
    // page's JS-level `ACTIVE_REGISTRATION_STATUSES` filter — `cancelled` is
    // excluded earlier, by the Prisma `where` clause itself.
    const lateCancelEmail = `bookings-count-late-cancel-${suffix2}@test.local`;
    const lateCancelStudent = await prisma.student.create({
      data: {
        firstName: 'LateCancel', lastName: 'Student', email: lateCancelEmail,
        claimedAt: new Date(),
        incomeTier: 4,
        account: { create: { email: lateCancelEmail } },
      },
      select: { id: true, accountId: true },
    });
    lateCancelAccountId = lateCancelStudent.accountId as string;
    await prisma.registration.create({
      data: { classId, studentId: lateCancelStudent.id, tierAtBooking: 4, status: 'late_cancel' },
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
      where: { accountId: { in: [teacherAccountId, studentAccountId, cancelledAccountId, lateCancelAccountId] } },
    });
    await prisma.student.deleteMany({ where: { email: { contains: suffix2 } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [teacherAccountId, studentAccountId, cancelledAccountId, lateCancelAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('counts only active registrations, not cancelled or late-cancelled ones, in the progress bar', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    // React's SSR HTML inserts `<!-- -->` hydration markers between adjacent
    // JSX expressions — `{min}–{max}` renders as `2<!-- -->–<!-- -->6`, not
    // the contiguous text a naive substring/regex check would expect.
    // Stripping them makes the assertion below robust to that, without
    // hardcoding where React happens to place them.
    const html = (await res.text()).replace(/<!-- -->/g, '');
    // One active registration (the viewer's own) against a min of 2 — neither
    // the cancelled row nor the late-cancelled one may count toward it. A
    // proximity check (e.g. "1"
    // within N chars of "/ 2–6") is not enough: RegistrationProgress's own
    // static className "text-[12px]" contains the digit "1", sitting closer
    // to "/ 2–6" than the real count ever could, so any such regex passes
    // whether the count is 1 or 2. This anchors structurally instead —
    // RegistrationProgress renders the count as the entire content of one
    // span, immediately followed by a sibling span whose entire content is
    // "/ min–max" — which the false-positive "1" (inside a class attribute,
    // never between a "</span>" and the next "<span") cannot satisfy.
    expect(html).toMatch(/<span[^>]*>1<\/span><span[^>]*>\/ 2–6<\/span>/);
  });

  it('shows the price line and a link to the booking page', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    const html = await res.text();
    expect(html).toContain('depending on how many join');
    expect(html).toContain(`/bookings-count-teacher-${suffix2}/book/${classId}`);
  });

  it('hands the cancel button the cancel-deadline instant, not the class start', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    const html = await res.text();
    // Independent of `cancelDeadlineInstant`: the fixture's class starts
    // 2099-07-01 09:00 Europe/Amsterdam (CEST, UTC+2) = 2099-07-01T07:00:00Z,
    // and the default HOURS_24 deadline is 24h before that. If the page ever
    // hands the button the class start instead (or reads the wrong
    // timezone), this literal stops appearing and the class-start instant
    // (2099-07-01T07:00:00.000Z) would appear in its place.
    expect(html).toContain('2099-06-30T07:00:00.000Z');
  });

  /**
   * Step 4's server-render check, run at the page rather than the component:
   * `CancelBookingButton`'s confirm copy sits behind a client `useState`
   * that only a tap sets, so a `renderToStaticMarkup` of the component alone
   * never reaches it (`cancel-booking-button.test.tsx` covers that gap and
   * says why). What a page fetch CAN show is the prop the server handed the
   * client component — Next.js serialises a Client Component's props into
   * the page's own HTML response, the same mechanic the instant-literal
   * assertion above already leans on. This student has no linked
   * `WaitlistEntry`, so the label is `formatInstantInZone` of the bare
   * deadline read in the teacher's zone — computed here the same way the
   * page computes it, not hardcoded, so a format change to
   * `formatInstantInZone` cannot silently desync the two.
   */
  it('hands the cancel button a label formatted server-side, in the teacher\'s zone', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    const html = await res.text();
    const expectedLabel = formatInstantInZone(
      new Date('2099-06-30T07:00:00.000Z'),
      'Europe/Amsterdam',
    );
    expect(html).toContain(expectedLabel);
  });
});

/**
 * `/bookings` — the Upcoming section must not quote a price or link to the
 * booking page for a class the student can no longer actually book: a
 * cancelled one, or one that has already gone `in_progress`. The booking
 * page itself 404s both (`[slug]/book/[classId]/page.tsx` refuses whenever
 * `cancelledAt !== null` or `status !== 'open'`), so a link there is dead —
 * and nobody is charged for a cancelled class, so a price quote beside its
 * "Cancelled" badge is a contradiction (#433).
 */
describe('GET /bookings (page) — price line and link gated on bookable state', () => {
  const suffix3 = uniqueSuffix();
  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let roomId = '';
  let openClassId = '';
  let cancelledClassId = '';
  let inProgressClassId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `bookings-gate-teacher-${suffix3}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'Teacher', email: teacherEmail,
        bio: 'Gating fixture teacher',
        pageSlug: `bookings-gate-teacher-${suffix3}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Gate Studio',
        address: `${suffix3} Gate St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 10, rentalRate: 15 },
    });

    const studentEmail = `bookings-gate-student-${suffix3}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gated', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        incomeTier: 3, tierSelectedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    const commonFields = {
      teacherId,
      teacherRoomId: teacherRoom.id,
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 40,
      minStudents: 1,
      maxStudents: 6,
    };

    const openClass = await createClassFixture(prisma, {
      ...commonFields,
      classType: 'Gate Open Class',
      date: new Date('2099-08-01'),
      status: 'open',
    });
    openClassId = openClass.id;

    const cancelledClass = await createClassFixture(prisma, {
      ...commonFields,
      classType: 'Gate Cancelled Class',
      date: new Date('2099-08-02'),
      status: 'open',
      cancelledAt: new Date(),
    });
    cancelledClassId = cancelledClass.id;

    const inProgressClass = await createClassFixture(prisma, {
      ...commonFields,
      classType: 'Gate In Progress Class',
      date: new Date('2099-08-03'),
      status: 'in_progress',
    });
    inProgressClassId = inProgressClass.id;

    await Promise.all(
      [openClassId, cancelledClassId, inProgressClassId].map((classId) =>
        prisma.registration.create({
          data: { classId, studentId, tierAtBooking: 3, status: 'registered' },
        }),
      ),
    );

    // Warm the route before the assertions score anything.
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
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

  it('shows the price line and link for a bookable open class, but not for a cancelled or in-progress one', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    // The open class: bookable, gets the price line and the link. The link
    // and the price line are siblings under one `{cls.status === 'open' &&
    // !cancelled && (...)}` gate (`bookings/page.tsx`), so the link's
    // presence/absence below stands for the whole gated block.
    expect(html).toContain('depending on how many join');
    expect(html).toContain(`/bookings-gate-teacher-${suffix3}/book/${openClassId}`);

    // The cancelled class: badge shows, but no dead link to a page that
    // would 404 it, and (by the same gate) no price quote beside a
    // "Cancelled" badge.
    expect(html).toContain('Cancelled');
    expect(html).not.toContain(`/bookings-gate-teacher-${suffix3}/book/${cancelledClassId}`);

    // The in-progress class: same reasoning — the booking page 404s it too.
    expect(html).toContain('In progress');
    expect(html).not.toContain(`/bookings-gate-teacher-${suffix3}/book/${inProgressClassId}`);
  });
});

/**
 * `/bookings` — #598: a class cancelled while it was `open` keeps that
 * status forever (#327), so the ledger split can't use status alone to
 * decide a cancelled class is Past. This class is dated well before `now`
 * and must move to Past classes, with a text "Cancelled" marker and no
 * payment UI — a cancelled class never has a payment or a breakdown
 * (docs/lock-order.md; `payment-breakdown.ts`'s own `completed` gate), so
 * #576 is unaffected by where it lands.
 */
describe('GET /bookings (page) — cancelled class moves to Past', () => {
  const suffix4 = uniqueSuffix();
  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let roomId = '';
  let lapsedPastClassId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `lapsed-past-teacher-${suffix4}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'LapsedPast', lastName: 'Teacher', email: teacherEmail,
        bio: 'Lapsed-past fixture teacher',
        pageSlug: `lapsed-past-teacher-${suffix4}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Lapsed Past Studio',
        address: `${suffix4} Lapsed St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 10, rentalRate: 15 },
    });

    const studentEmail = `lapsed-past-student-${suffix4}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'LapsedPast', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        incomeTier: 3, tierSelectedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    const lapsedPastClass = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Lapsed Past Class',
      date: new Date('2026-01-10'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 40,
      minStudents: 1,
      maxStudents: 6,
      status: 'open',
      cancelledAt: new Date('2026-01-09T00:00:00.000Z'),
    });
    lapsedPastClassId = lapsedPastClass.id;

    await prisma.registration.create({
      data: { classId: lapsedPastClassId, studentId, tierAtBooking: 3, status: 'registered' },
    });

    // Warm the route before the assertions score anything.
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
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

  it('shows a cancelled-in-the-past class under Past classes, marked cancelled, with no payment UI', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = await res.text();

    // This student has exactly one registration. If it were still bucketed
    // under Upcoming, the Upcoming section (`{upcoming.length > 0 && (...)}`)
    // would render and Past classes would not.
    expect(html).toContain('Past classes');
    expect(html).not.toContain('Upcoming');
    expect(html).toContain('Lapsed Past Class');

    // Text marker, no payment amount, no disclosures — #576's breakdown
    // included, since none of the three renders for a class that never
    // reached `completed`.
    expect(html).toContain('Cancelled');
    expect(html).not.toContain('€');
    expect(html).not.toContain('How to pay');
    expect(html).not.toContain('Where your payment goes');
  });
});

/**
 * `/bookings` — the Waitlist section's price line for a signed-in student
 * who has not yet chosen an income tier. `resolvePriceLine` returns its
 * anonymous branch whenever `viewer.tierSelectedAt` is null; every other
 * fixture student in this file already has a tier, so this is the only
 * coverage of that branch through an actual page request on any of the
 * three `resolvePriceLine` call sites (#433).
 */
describe('GET /bookings (page) — waitlist section, viewer has not chosen a tier', () => {
  const suffix4 = uniqueSuffix();
  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let activeAccountId = '';
  let lateCancelAccountId = '';
  let roomId = '';
  let classId = '';

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `bookings-wl-teacher-${suffix4}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Waitlist', lastName: 'Teacher', email: teacherEmail,
        bio: 'Waitlist fixture teacher',
        pageSlug: `bookings-wl-teacher-${suffix4}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Waitlist Studio',
        address: `${suffix4} Waitlist St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 5, rentalRate: 15 },
    });

    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Waitlist Test Class',
      date: new Date('2099-09-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 30,
      minStudents: 2,
      maxStudents: 5,
      status: 'open',
    });
    classId = cls.id;

    // The viewer: signed in, waitlisted, but has never chosen an income
    // tier — `tierSelectedAt: null` is what should trigger the anonymous
    // branch here, exactly as it does in the unit tests of resolvePriceLine.
    const studentEmail = `bookings-wl-student-${suffix4}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Undecided', lastName: 'Student', email: studentEmail,
        claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId as string;
    studentToken = await seedSession(prisma, studentAccountId);

    await prisma.waitlistEntry.create({
      data: { classId, studentId, position: 1, status: 'waiting' },
    });

    // A registered student, filling the pool the anonymous estimate is
    // built from.
    const activeEmail = `bookings-wl-active-${suffix4}@test.local`;
    const activeStudent = await prisma.student.create({
      data: {
        firstName: 'Active', lastName: 'Student', email: activeEmail,
        claimedAt: new Date(),
        incomeTier: 3,
        account: { create: { email: activeEmail } },
      },
      select: { id: true, accountId: true },
    });
    activeAccountId = activeStudent.accountId as string;
    await prisma.registration.create({
      data: { classId, studentId: activeStudent.id, tierAtBooking: 3, status: 'registered' },
    });

    // A late-cancelled student — billed, but must not inflate the Waitlist
    // section's progress-bar count either (same rule the Upcoming section
    // enforces, `bookings/page.tsx`).
    const lateCancelEmail = `bookings-wl-late-cancel-${suffix4}@test.local`;
    const lateCancelStudent = await prisma.student.create({
      data: {
        firstName: 'LateCancel', lastName: 'Student', email: lateCancelEmail,
        claimedAt: new Date(),
        incomeTier: 5,
        account: { create: { email: lateCancelEmail } },
      },
      select: { id: true, accountId: true },
    });
    lateCancelAccountId = lateCancelStudent.accountId as string;
    await prisma.registration.create({
      data: { classId, studentId: lateCancelStudent.id, tierAtBooking: 5, status: 'late_cancel' },
    });

    // Warm the route before the assertions score anything.
    await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) }).catch(() => {});
  }, 20_000);

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: {
        accountId: {
          in: [teacherAccountId, studentAccountId, activeAccountId, lateCancelAccountId],
        },
      },
    });
    await prisma.student.deleteMany({ where: { email: { contains: suffix4 } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: {
        id: { in: [teacherAccountId, studentAccountId, activeAccountId, lateCancelAccountId] },
      },
    });
    await prisma.$disconnect();
  });

  it('shows the anonymous price line, not the personal one, and excludes the late-cancelled row from the count', async () => {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    const html = (await res.text()).replace(/<!-- -->/g, '');

    expect(html).toContain('depending on your income tier');
    expect(html).not.toContain('depending on how many join');

    // One active registration (the other student's) against a min of 2 —
    // the late-cancelled row must not count toward it. Same structural
    // anchor as the Upcoming section's count test above.
    expect(html).toMatch(/<span[^>]*>1<\/span><span[^>]*>\/ 2–5<\/span>/);
  });
});

/**
 * `/bookings` — the past-class payment breakdown (#576).
 *
 * Each class carries snapshot values no other row on the page renders, so a
 * value's presence or absence is attributable to that class's disclosure.
 * The breakdown's accessible name includes the class type too, so the label
 * assertions are attributable the same way.
 */
describe('GET /bookings (page) — past-class payment breakdown', () => {
  const suffixB = uniqueSuffix();

  let teacherId = '';
  let teacherAccountId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let roomId = '';

  const pendingClass = { classType: `Breakdown Pending ${suffixB}`, date: new Date('2026-06-02T00:00:00.000Z') };
  const paidClass = { classType: `Breakdown Paid ${suffixB}`, date: new Date('2026-06-03T00:00:00.000Z') };
  const waivedClass = { classType: `Breakdown Waived ${suffixB}`, date: new Date('2026-06-04T00:00:00.000Z') };
  const unsnapshottedClass = {
    classType: `Breakdown Unsnapshotted ${suffixB}`,
    date: new Date('2026-06-05T00:00:00.000Z'),
  };

  const breakdownLabel = (c: { classType: string; date: Date }) =>
    `Where your payment goes — ${c.classType}, ${formatDayHeader(c.date)}`;

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `breakdown-teacher-${suffixB}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Breakdown',
        lastName: 'Teacher',
        email: teacherEmail,
        bio: 'Breakdown fixture teacher',
        pageSlug: `breakdown-teacher-${suffixB}`,
        account: { create: { email: teacherEmail } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Breakdown Studio',
        address: `${suffixB} Breakdown St`,
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

    const studentEmail = `breakdown-student-${suffixB}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Breakdown',
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

    const completedClassWithPayment = async (
      c: { classType: string; date: Date },
      economics: {
        roomCost: number;
        minRate: number;
        targetRate: number;
        minStudents: number;
        maxStudents: number;
        effectiveTeacherRate: number | null;
        totalStudents: number | null;
        totalRevenue: number | null;
      },
      payment: { amount: number; status: 'pending' | 'paid' | 'not_charged' },
    ) => {
      const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: c.classType,
        date: c.date,
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        status: 'completed',
        ...economics,
      });
      const registration = await prisma.registration.create({
        data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 },
      });
      await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: payment.amount,
          status: payment.status,
          paidAt: payment.status === 'paid' ? new Date() : null,
          notChargedAt: payment.status === 'not_charged' ? new Date() : null,
        },
      });
    };

    // 41.30 + 16.25 = 57.55.
    await completedClassWithPayment(
      pendingClass,
      { roomCost: 41.3, minRate: 10, targetRate: 16.25, minStudents: 3, maxStudents: 7,
        effectiveTeacherRate: 16.25, totalStudents: 7, totalRevenue: 57.55 },
      { amount: 8.15, status: 'pending' },
    );
    // 42.60 − 4.00 = 38.60.
    await completedClassWithPayment(
      paidClass,
      { roomCost: 42.6, minRate: -4, targetRate: 20, minStudents: 5, maxStudents: 10,
        effectiveTeacherRate: -4, totalStudents: 5, totalRevenue: 38.6 },
      { amount: 7.7, status: 'paid' },
    );
    // 43.90 + 17.35 = 61.25.
    await completedClassWithPayment(
      waivedClass,
      { roomCost: 43.9, minRate: 10, targetRate: 17.35, minStudents: 3, maxStudents: 6,
        effectiveTeacherRate: 17.35, totalStudents: 6, totalRevenue: 61.25 },
      { amount: 10.2, status: 'not_charged' },
    );
    // Completed with no snapshot — the defect branch; see
    // docs/superpowers/specs/2026-09-14-past-class-payment-breakdown-design.md,
    // "When the disclosure renders".
    await completedClassWithPayment(
      unsnapshottedClass,
      { roomCost: 44.7, minRate: 10, targetRate: 20, minStudents: 3, maxStudents: 10,
        effectiveTeacherRate: null, totalStudents: null, totalRevenue: null },
      { amount: 9.35, status: 'pending' },
    );

    // Warm the route: `next dev` compiles a page lazily on its first request.
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

  async function bookingsHtml(): Promise<string> {
    const res = await fetch(`${BASE_URL}/bookings`, { headers: cookie(studentToken) });
    expect(res.status).toBe(200);
    return res.text();
  }

  it('shows a pending payment the room, teacher, class total, class size and share behind it', async () => {
    const html = await bookingsHtml();
    expect(html).toContain(breakdownLabel(pendingClass));
    expect(html).toContain(`How to pay — ${pendingClass.classType}, ${formatDayHeader(pendingClass.date)}`);
    expect(html).toContain('€41.30');
    expect(html).toContain('€16.25');
    expect(html).toContain('€57.55');
    // Label and value side by side in the breakdown's description list, so the
    // count is the snapshot's and the share is the breakdown's, not the row's.
    expect(html).toMatch(/Students<\/dt><dd[^>]*>7<\/dd>/);
    expect(html).toMatch(/Your share<\/dt><dd[^>]*>€8\.15<\/dd>/);
  });

  it('shows a paid payment its breakdown, with a negative teacher line when the teacher covered part of the room', async () => {
    const html = await bookingsHtml();
    expect(html).toContain(breakdownLabel(paidClass));
    expect(html).toContain('€42.60');
    expect(html).toContain('−€4.00');
    expect(html).toContain('€38.60');
  });

  it('shows a not_charged payment no breakdown', async () => {
    const html = await bookingsHtml();
    // The row itself renders, so the absences below are about its disclosure.
    expect(html).toContain(waivedClass.classType);
    expect(html).not.toContain(breakdownLabel(waivedClass));
    expect(html).not.toContain('€43.90');
    expect(html).not.toContain('€61.25');
  });

  it('renders a completed class with no snapshot without a breakdown, and the page still loads', async () => {
    const html = await bookingsHtml();
    expect(html).toContain(unsnapshottedClass.classType);
    expect(html).not.toContain(breakdownLabel(unsnapshottedClass));
    expect(html).not.toContain('€44.70');
  });
});

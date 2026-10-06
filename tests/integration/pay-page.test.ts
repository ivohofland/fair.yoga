import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { formatDayHeader } from '@/lib/format';
import { formatInstantInZone } from '@/lib/timezone';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const IBAN = 'NL91ABNA0417164300';
const HOLDER = 'P. Paypage';

/**
 * `/bookings/[classId]/pay` — one class's payment, for the signed-in student.
 *
 * The page is keyed by the class and the session's own student, so every
 * class that is not this student's — someone else's, one that does not exist
 * — answers the same 404, and so does this student's own class with no
 * payment.
 */
describe('GET /bookings/[classId]/pay', () => {
  const accountIds: string[] = [];
  const teacherIds: string[] = [];
  const roomIds: string[] = [];
  const studentIds: string[] = [];
  let studentToken = '';
  let otherStudentToken = '';
  let teacherToken = '';
  let dualToken = '';
  const classIds = {
    overdue: '',
    paid: '',
    notCharged: '',
    cancelledRegistration: '',
    noBank: '',
    dual: '',
    lateCancel: '',
    noShow: '',
    lateCancelWaived: '',
    chargedWithoutPayment: '',
    paidWithoutTimestamp: '',
    gbp: '',
  };
  const overdueClass = { classType: `Pay Overdue ${suffix}`, date: new Date('2026-06-01T00:00:00.000Z') };

  async function makeTeacher(
    key: string,
    bank: { bankIban: string | null; bankAccountName: string | null },
  ): Promise<{ id: string; accountId: string; teacherRoomId: string }> {
    const email = `paypage-${key}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: `Pay${key}`,
        lastName: 'Teacher',
        email,
        bio: 'Pay page fixture',
        pageSlug: `paypage-${key}-${suffix}`,
        defaultTimezone: 'UTC',
        ...bank,
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    const room = await prisma.room.create({
      data: {
        venueName: 'Pay Studio',
        address: `${suffix} ${key} St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    roomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 25 },
    });
    return { ...teacher, teacherRoomId: teacherRoom.id };
  }

  async function makeStudent(key: string, accountId?: string): Promise<{ id: string; accountId: string }> {
    const email = `paypage-student-${key}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: `Student${key}`,
        lastName: 'Payer',
        email,
        claimedAt: new Date(),
        account: accountId ? { connect: { id: accountId } } : { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    studentIds.push(student.id);
    const ownAccount = student.accountId as string;
    if (!accountId) accountIds.push(ownAccount);
    return { id: student.id, accountId: ownAccount };
  }

  async function completedClass(
    teacher: { id: string; teacherRoomId: string },
    c: { classType: string; date: Date; currency?: 'EUR' | 'GBP' },
    studentId: string,
    registrationStatus: 'attended' | 'cancelled' | 'late_cancel' | 'no_show',
    payment: {
      amount: number;
      status: 'pending' | 'overdue' | 'paid' | 'not_charged';
      /** Overrides the default `paidAt` of a `paid` fixture. */
      paidAt?: Date | null;
    } | null,
  ): Promise<string> {
    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacher.teacherRoomId,
      classType: c.classType,
      date: c.date,
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
      effectiveTeacherRate: 10,
      totalStudents: 4,
      totalRevenue: 30,
      ...(c.currency ? { currency: c.currency } : {}),
    });
    const registration = await prisma.registration.create({
      data: {
        classId: cls.id,
        studentId,
        status: registrationStatus,
        tierAtBooking: 3,
        cancelledAt: registrationStatus === 'late_cancel' || registrationStatus === 'cancelled' ? new Date('2026-05-31T12:00:00.000Z') : null,
      },
    });
    if (payment) {
      await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: payment.amount,
          status: payment.status,
          paidAt:
            payment.paidAt !== undefined
              ? payment.paidAt
              : payment.status === 'paid'
                ? new Date('2026-06-05T10:00:00.000Z')
                : null,
          notChargedAt: payment.status === 'not_charged' ? new Date() : null,
        },
      });
    }
    return cls.id;
  }

  async function payPage(classId: string, token: string | null): Promise<Response> {
    return fetch(`${BASE_URL}/bookings/${classId}/pay`, {
      headers: token ? cookie(token) : {},
      redirect: 'manual',
    });
  }

  beforeAll(async () => {
    await prisma.$connect();

    const bankTeacher = await makeTeacher('bank', { bankIban: IBAN, bankAccountName: HOLDER });
    const noBankTeacher = await makeTeacher('nobank', { bankIban: null, bankAccountName: null });

    const student = await makeStudent('main');
    studentToken = await seedSession(prisma, student.accountId);
    const otherStudent = await makeStudent('other');
    otherStudentToken = await seedSession(prisma, otherStudent.accountId);
    teacherToken = await seedSession(prisma, bankTeacher.accountId);

    // An account with both hats, paying for its own class as a student.
    const dualTeacher = await makeTeacher('dual', { bankIban: null, bankAccountName: null });
    const dualStudent = await makeStudent('dual', dualTeacher.accountId);
    dualToken = await seedSession(prisma, dualTeacher.accountId);

    classIds.overdue = await completedClass(bankTeacher, overdueClass, student.id, 'attended', { amount: 5.75, status: 'overdue' });
    classIds.paid = await completedClass(bankTeacher, { classType: `Pay Paid ${suffix}`, date: new Date('2026-06-02T00:00:00.000Z') }, student.id, 'attended', { amount: 6.11, status: 'paid' });
    classIds.notCharged = await completedClass(bankTeacher, { classType: `Pay Waived ${suffix}`, date: new Date('2026-06-03T00:00:00.000Z') }, student.id, 'attended', { amount: 7.12, status: 'not_charged' });
    classIds.cancelledRegistration = await completedClass(bankTeacher, { classType: `Pay Cancelled ${suffix}`, date: new Date('2026-06-04T00:00:00.000Z') }, student.id, 'cancelled', null);
    classIds.noBank = await completedClass(noBankTeacher, { classType: `Pay NoBank ${suffix}`, date: new Date('2026-06-01T00:00:00.000Z') }, student.id, 'attended', { amount: 8.13, status: 'pending' });
    classIds.dual = await completedClass(noBankTeacher, { classType: `Pay Dual ${suffix}`, date: new Date('2026-06-02T00:00:00.000Z') }, dualStudent.id, 'attended', { amount: 4.5, status: 'pending' });
    classIds.lateCancel = await completedClass(bankTeacher, { classType: `Pay Late ${suffix}`, date: new Date('2026-06-06T00:00:00.000Z') }, student.id, 'late_cancel', { amount: 5.5, status: 'pending' });
    classIds.noShow = await completedClass(bankTeacher, { classType: `Pay Absent ${suffix}`, date: new Date('2026-06-07T00:00:00.000Z') }, student.id, 'no_show', { amount: 5.25, status: 'pending' });
    classIds.lateCancelWaived = await completedClass(bankTeacher, { classType: `Pay LateWaived ${suffix}`, date: new Date('2026-06-10T00:00:00.000Z') }, student.id, 'late_cancel', { amount: 5.5, status: 'not_charged' });
    classIds.chargedWithoutPayment = await completedClass(bankTeacher, { classType: `Pay Missing ${suffix}`, date: new Date('2026-06-08T00:00:00.000Z') }, student.id, 'attended', null);
    classIds.paidWithoutTimestamp = await completedClass(bankTeacher, { classType: `Pay Undated ${suffix}`, date: new Date('2026-06-09T00:00:00.000Z') }, student.id, 'attended', { amount: 6.5, status: 'paid', paidAt: null });

    classIds.gbp = await completedClass(bankTeacher, { classType: `Pay Pounds ${suffix}`, date: new Date('2026-06-11T00:00:00.000Z'), currency: 'GBP' }, student.id, 'attended', { amount: 9.5, status: 'pending' });

    // Warm the route: `next dev` compiles a page lazily on its first request.
    await payPage(classIds.overdue, studentToken).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    if (studentIds.length > 0) {
      await prisma.payment.deleteMany({ where: { registration: { studentId: { in: studentIds } } } });
      await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
    }
    if (teacherIds.length > 0) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomIds.length > 0) await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    if (studentIds.length > 0) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('offers an outstanding payment its methods, with the bank details inside them', async () => {
    const res = await payPage(classIds.overdue, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(overdueClass.classType);
    expect(html).toContain('! Overdue');
    expect(html).toContain('How would you like to pay?');
    expect(html).toContain('Bank transfer');
    expect(html).toContain('QR code');
    expect(html).toContain('name="pay-method"');
    expect(html).toContain(IBAN);
    expect(html).toContain(HOLDER);
    expect(html).toContain('href="/bookings"');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  // Bank methods exist only for euros until accounts are per currency, so a
  // pound payment must not produce a euro transfer or QR.
  it('shows a pound payment in pounds and offers no bank method for it', async () => {
    const res = await payPage(classIds.gbp, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('£9.50');
    expect(html).not.toContain('€');
    expect(html).not.toContain('Bank transfer');
    expect(html).not.toContain('QR code');
    expect(html).not.toContain(IBAN);
    expect(html).toContain('Pay Paybank directly');
  });

  it('shows why the amount is what it is', async () => {
    const html = await (await payPage(classIds.overdue, studentToken)).text();
    expect(html).toContain(`Where your payment goes — ${overdueClass.classType}, ${formatDayHeader(overdueClass.date)}`);
  });

  it('tells a student whose teacher has no bank details to pay directly', async () => {
    const res = await payPage(classIds.noBank, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Pay Paynobank directly');
    expect(html).not.toContain('How would you like to pay?');
  });

  it('tells a late cancel why the class is still charged', async () => {
    const res = await payPage(classIds.lateCancel, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Cancelled after the deadline — this class is still charged.');
    expect(html).not.toContain('Marked absent');
  });

  it('tells a no-show why the class is still charged', async () => {
    const res = await payPage(classIds.noShow, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Marked absent — this class is still charged.');
    expect(html).not.toContain('Cancelled after the deadline');
  });

  // A waived payment is not charged, so nothing may say it still is.
  it('gives a waived late cancel no charge explanation', async () => {
    const res = await payPage(classIds.lateCancelWaived, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('⊘ Not charged');
    expect(html).toContain('Paybank isn’t charging for this class.');
    expect(html).not.toContain('still charged');
  });

  it('gives an attended registration no charge explanation', async () => {
    const html = await (await payPage(classIds.overdue, studentToken)).text();
    expect(html).not.toContain('this class is still charged');
  });

  // The log line is pinned in `pay-page.server.test.ts`; this pins the page's
  // answer, which stays the same.
  it('answers a charged registration on a completed class with no payment as not found', async () => {
    expect((await payPage(classIds.chargedWithoutPayment, studentToken)).status).toBe(404);
  });

  it('answers a paid payment with no timestamp without naming a date', async () => {
    const res = await payPage(classIds.paidWithoutTimestamp, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('✓ Paid');
    expect(html).toContain('Marked paid.');
  });

  it('answers a paid payment calmly, with no methods', async () => {
    const res = await payPage(classIds.paid, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('✓ Paid');
    expect(html).toContain(`Marked paid ${formatInstantInZone(new Date('2026-06-05T10:00:00.000Z'), 'UTC')}.`);
    expect(html).not.toContain('How would you like to pay?');
    expect(html).not.toContain(IBAN);
  });

  it('answers a not-charged payment calmly, with no methods', async () => {
    const res = await payPage(classIds.notCharged, studentToken);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('⊘ Not charged');
    expect(html).toContain('Paybank isn’t charging for this class.');
    expect(html).not.toContain(IBAN);
  });

  it("answers another student's class as not found", async () => {
    const res = await payPage(classIds.overdue, otherStudentToken);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(overdueClass.classType);
  });

  it('answers a registration that has no payment as not found', async () => {
    expect((await payPage(classIds.cancelledRegistration, studentToken)).status).toBe(404);
  });

  // Class.id is a text column: a malformed id misses, it does not throw.
  it('answers a malformed or unknown class id as not found', async () => {
    expect((await payPage('not-a-uuid', studentToken)).status).toBe(404);
    expect((await payPage('00000000-0000-0000-0000-000000000000', studentToken)).status).toBe(404);
  });

  // The student layout admits on studentId, so a two-hat account gets through.
  it('opens for an account that is both teacher and student', async () => {
    const res = await payPage(classIds.dual, dualToken);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Pay Dual ${suffix}`);
  });

  it('sends a teacher-only account to their schedule', async () => {
    const res = await payPage(classIds.overdue, teacherToken);
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location') ?? '', BASE_URL).pathname).toBe('/schedule');
  });

  it('sends a signed-out visitor to sign in, keeping the destination', async () => {
    const res = await payPage(classIds.overdue, null);
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '', BASE_URL);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.get('redirect')).toBe(`/bookings/${classIds.overdue}/pay`);
  });
});

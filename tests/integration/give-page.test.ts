import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, cookie, freshIp, uniqueSuffix, seedSession } from '../helpers';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { PAYMENTS_PAUSED_COPY } from '@/lib/payment-methods';
import { givePagePath } from '@/lib/notification-links';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();
const IBAN_SHOWN = 'NL91ABNA0417164300';
const BIC = 'ABNANL2A';
const HOLDER = 'G. Giver';
const LINK = 'https://revolut.me/anna';
/** How React escapes the apostrophe in the prompt's link text. */
const PROMPT_LABEL = 'Give if you&#x27;d like';

type TeacherFixture = { id: string; accountId: string; teacherRoomId: string };

/**
 * `/bookings/[classId]/give` and the prompt's Hide (#912). Every 404 case
 * differs from the eligible booking in one condition, except the cancelled
 * class: a completed class cannot be cancelled
 * (`CalendarEntry_not_cancelled_and_completed`), so that fixture is an open
 * class with `cancelledAt` set, which differs in two.
 */
describe('the give page and the donation prompt (#912)', () => {
  const accountIds: string[] = [];
  const teacherIds: string[] = [];
  const roomIds: string[] = [];
  const studentIds: string[] = [];
  let studentToken = '';
  let otherStudentToken = '';
  let listToken = '';
  const classIds = {
    bank: '', noMethod: '', paused: '', linkOnly: '', tiered: '', inProgress: '',
    noShow: '', uninvited: '', cancelled: '', list: '',
  };
  const regIds = { bank: '', uninvited: '', list: '' };
  const listClassType = `Give List ${suffix}`;

  async function makeTeacher(key: string, withBank: boolean, paymentLink: string | null = null, paused = false): Promise<TeacherFixture> {
    const email = `give-${key}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: `Give${key}`,
        lastName: 'Teacher',
        email,
        bio: 'Give page fixture',
        pageSlug: `give-${key}-${suffix}`,
        defaultTimezone: 'UTC',
        paymentLink,
        paymentsPausedAt: paused ? new Date() : null,
        currency: 'EUR',
        ...(withBank ? { bankAccounts: { create: [{ currency: 'EUR', holderName: HOLDER, iban: IBAN_SHOWN, bic: BIC }] } } : {}),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    const room = await prisma.room.create({
      data: {
        venueName: 'Give Studio', address: `${suffix} ${key} St`, city: 'Amsterdam',
        postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: teacher.id,
      },
    });
    roomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 25 },
    });
    return { ...teacher, teacherRoomId: teacherRoom.id };
  }

  async function makeStudent(key: string): Promise<{ id: string; accountId: string }> {
    const email = `give-student-${key}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: { firstName: `Student${key}`, lastName: 'Giver', email, claimedAt: new Date(), account: { create: { email } } },
      select: { id: true, accountId: true },
    });
    studentIds.push(student.id);
    accountIds.push(student.accountId as string);
    return { id: student.id, accountId: student.accountId as string };
  }

  let dayOffset = 0;
  /** One donation class (completed by default), with the student's booking in it. */
  async function booking(
    teacher: TeacherFixture,
    studentId: string,
    o: {
      classType?: string;
      pricingMode?: 'donation' | 'tiered';
      status?: 'completed' | 'in_progress' | 'open';
      cancelled?: boolean;
      registrationStatus?: 'attended' | 'no_show';
      invited?: boolean;
    } = {},
  ): Promise<{ classId: string; registrationId: string }> {
    dayOffset += 1;
    const date = new Date(Date.UTC(2026, 5, dayOffset));
    const tiered = o.pricingMode === 'tiered';
    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacher.teacherRoomId,
      classType: o.classType ?? `Give ${dayOffset} ${suffix}`,
      date,
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: tiered ? 20 : 0,
      minRate: tiered ? 10 : 0,
      targetRate: tiered ? 20 : 0,
      minStudents: 1,
      maxStudents: 10,
      status: o.status ?? 'completed',
      pricingMode: o.pricingMode ?? 'donation',
      ...(o.cancelled ? { cancelledAt: new Date('2026-05-31T12:00:00.000Z') } : {}),
    });
    const registration = await prisma.registration.create({
      data: {
        classId: cls.id,
        studentId,
        status: o.registrationStatus ?? 'attended',
        tierAtBooking: 3,
        donationInvitedAt: o.invited === false ? null : new Date(),
      },
      select: { id: true },
    });
    return { classId: cls.id, registrationId: registration.id };
  }

  const give = (token: string, classId: string) =>
    fetch(`${BASE_URL}${givePagePath(classId)}`, { headers: { ...cookie(token), ...freshIp() }, redirect: 'manual' });

  const hide = (token: string, regId: string) =>
    fetch(`${BASE_URL}/api/registrations/${regId}/donation-prompt/hide`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });

  const bookingsPage = (token: string) =>
    fetch(`${BASE_URL}/bookings`, { headers: { ...cookie(token), ...freshIp() }, redirect: 'manual' });

  beforeAll(async () => {
    await prisma.$connect();
    const bankTeacher = await makeTeacher('bank', true, LINK);
    const noMethodTeacher = await makeTeacher('nomethod', false);
    const pausedTeacher = await makeTeacher('paused', true, LINK, true);
    const linkTeacher = await makeTeacher('link', false, LINK);

    const student = await makeStudent('main');
    studentToken = await seedSession(prisma, student.accountId);
    const other = await makeStudent('other');
    otherStudentToken = await seedSession(prisma, other.accountId);
    const listStudent = await makeStudent('list');
    listToken = await seedSession(prisma, listStudent.accountId);

    const bank = await booking(bankTeacher, student.id);
    classIds.bank = bank.classId;
    regIds.bank = bank.registrationId;
    classIds.noMethod = (await booking(noMethodTeacher, student.id)).classId;
    classIds.paused = (await booking(pausedTeacher, student.id)).classId;
    classIds.linkOnly = (await booking(linkTeacher, student.id)).classId;
    classIds.tiered = (await booking(bankTeacher, student.id, { pricingMode: 'tiered' })).classId;
    classIds.inProgress = (await booking(bankTeacher, student.id, { status: 'in_progress' })).classId;
    // Invited as attended, then corrected to no_show: the invitation stamp stays.
    classIds.noShow = (await booking(bankTeacher, student.id, { registrationStatus: 'no_show' })).classId;
    const uninvited = await booking(bankTeacher, student.id, { invited: false });
    classIds.uninvited = uninvited.classId;
    regIds.uninvited = uninvited.registrationId;
    classIds.cancelled = (await booking(bankTeacher, student.id, { status: 'open', cancelled: true })).classId;
    const list = await booking(bankTeacher, listStudent.id, { classType: listClassType });
    classIds.list = list.classId;
    regIds.list = list.registrationId;

    // `next dev` compiles a route on its first request.
    await give(studentToken, classIds.bank).catch(() => {});
    await hide(otherStudentToken, regIds.uninvited).catch(() => {});
    await bookingsPage(listToken).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    if (studentIds.length > 0) {
      await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
    }
    if (teacherIds.length > 0) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherBankAccount.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomIds.length > 0) await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    if (studentIds.length > 0) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('(#912) shows the bank details with no amount, no breakdown, no sent claim', async () => {
    const res = await give(studentToken, classIds.bank);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Thank you for coming.');
    expect(html).toContain(IBAN_SHOWN);
    expect(html).toContain('name="give-method"');
    expect(html).not.toMatch(/€\s?\d|EUR\d/);
    expect(html).not.toContain('Room');
    expect(html).not.toContain('I&#x27;ve sent it');
  });

  it('(#912) offers an open-ended payment link without an amount', async () => {
    const html = await (await give(studentToken, classIds.linkOnly)).text();
    expect(html).toContain('Thank you for coming.');
    expect(html).toContain(LINK.replace('https://', ''));
    expect(html).not.toMatch(/€\s?\d/);
  });

  it('(#912) tells a student with no teacher method to give directly', async () => {
    const html = await (await give(studentToken, classIds.noMethod)).text();
    expect(html).toContain('Give your teacher directly, however suits you.');
  });

  it('(#912) shows the hold-off line, and no method, while payments are paused', async () => {
    const html = await (await give(studentToken, classIds.paused)).text();
    expect(html).toContain(PAYMENTS_PAUSED_COPY);
    expect(html).not.toContain(IBAN_SHOWN);
  });

  it.each([
    ['another student', () => give(otherStudentToken, classIds.bank)],
    ['a tiered class', () => give(studentToken, classIds.tiered)],
    ['a not-yet-completed donation class', () => give(studentToken, classIds.inProgress)],
    ['a no_show booking that was invited first (Review Focus 5)', () => give(studentToken, classIds.noShow)],
    ['a never-invited booking', () => give(studentToken, classIds.uninvited)],
    ['a cancelled class', () => give(studentToken, classIds.cancelled)],
  ])('(#912) answers 404 for %s', async (_label, request) => {
    expect((await request()).status).toBe(404);
  });

  describe('POST /api/registrations/[id]/donation-prompt/hide', () => {
    it('(#912) hides the student own prompt, then answers unchanged, and the give page still opens', async () => {
      await expectApplied(await hide(studentToken, regIds.bank));
      await expectUnchanged(await hide(studentToken, regIds.bank));
      expect((await give(studentToken, classIds.bank)).status).toBe(200);
    });
    it('(#912) refuses another student with 403', async () => {
      expect((await hide(otherStudentToken, regIds.bank)).status).toBe(403);
    });
    it('(#912) refuses a never-invited booking with DONATION_NOT_INVITED', async () => {
      await expectRefusal(await hide(studentToken, regIds.uninvited), 'DONATION_NOT_INVITED');
    });
    it('(#912) answers NOT_FOUND for a booking that does not exist', async () => {
      await expectRefusal(await hide(studentToken, '00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    });
  });

  it('(#912) the bookings list offers the prompt, then not after Hide, and never a price', async () => {
    const before = await (await bookingsPage(listToken)).text();
    expect(before).toContain(listClassType);
    expect(before).toContain(PROMPT_LABEL);
    expect(before).toContain(`href="${givePagePath(classIds.list)}"`);
    expect(before).not.toContain('€');

    await expectApplied(await hide(listToken, regIds.list));

    const after = await (await bookingsPage(listToken)).text();
    expect(after).toContain(listClassType);
    expect(after).not.toContain(PROMPT_LABEL);
    expect(after).not.toContain(givePagePath(classIds.list));
  });
});

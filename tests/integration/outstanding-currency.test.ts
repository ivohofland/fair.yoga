import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, type Currency, type PaymentStatus } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/** Strips React's text-node markers and the flight payload's string escapes. */
function normalise(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('\\"', '"');
}

/** The text of every element carrying `data-testid="<testId>"`, in document order. */
function testIdTexts(html: string, testId: string): string[] {
  return [...html.matchAll(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`, 'g'))].map((m) => m[1] ?? '');
}

/**
 * The two outstanding-payment sums outside reporting (#758): the payments
 * overview's Outstanding and Received cards and the student detail page's
 * archive offer (`ArchiveStudentButton`'s `outstanding.totals`). A teacher owed
 * money in two currencies sees one line per currency, never their sum, with
 * their own currency first; each payment row shows its own class's currency.
 *
 * Fixture, the same for a EUR and a GBP teacher: one student owes €12.00 and
 * €8.00 (two EUR classes) and £7.00 (one GBP class), and has paid €5.00 and
 * £4.00. Per-row amounts never read €20.00, so that string comes only from a
 * total; 27.00 and 9.00 are the cross-currency sums. A third, GBP, teacher has
 * no payments at all.
 */
describe('outstanding totals across currencies', () => {
  const teacherIds: string[] = [];
  const accountIds: string[] = [];
  let studentId: string | undefined;
  let roomId: string | undefined;
  const tokens: Partial<Record<'eur' | 'gbp' | 'empty', string>> = {};

  function tokenOf(tag: 'eur' | 'gbp' | 'empty'): string {
    const token = tokens[tag];
    if (token === undefined) throw new Error(`no session for the ${tag} teacher`);
    return token;
  }

  async function makeTeacher(tag: 'eur' | 'gbp' | 'empty', currency: Currency): Promise<string> {
    const email = `outcur-${tag}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Outstanding',
        lastName: tag,
        email,
        bio: 'Outstanding currency fixture teacher',
        pageSlug: `outcur-${tag}-${suffix}`,
        currency,
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    tokens[tag] = await seedSession(prisma, teacher.accountId);
    return teacher.id;
  }

  async function owe(teacherId: string, student: string, room: string): Promise<void> {
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room, capacityOverride: 15, rentalRate: 10 },
    });
    await prisma.teacherStudent.create({ data: { teacherId, studentId: student } });

    async function payment(currency: Currency, amount: string, day: number, status: PaymentStatus) {
      const cls = await createClassFixture(prisma, {
        teacherId,
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
        data: { classId: cls.id, studentId: student, status: 'attended', tierAtBooking: 3 },
      });
      await prisma.payment.create({
        data: {
          registrationId: registration.id,
          amount: new Prisma.Decimal(amount),
          status,
          ...(status === 'paid' ? { method: 'cash' as const, paidAt: new Date('2026-08-20T12:00:00.000Z') } : {}),
        },
      });
    }

    await payment('EUR', '12.00', 10, 'pending');
    await payment('EUR', '8.00', 11, 'pending');
    await payment('GBP', '7.00', 12, 'pending');
    await payment('EUR', '5.00', 13, 'paid');
    await payment('GBP', '4.00', 14, 'paid');
  }

  beforeAll(async () => {
    await prisma.$connect();

    const eur = await makeTeacher('eur', 'EUR');
    const gbp = await makeTeacher('gbp', 'GBP');
    await makeTeacher('empty', 'GBP');

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
    if (student.accountId !== null) accountIds.push(student.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Outstanding Hall',
        address: `${suffix} Outstanding St`,
        city: 'Amsterdam',
        postcode: '1000OC',
        roomName: 'Main Room',
        maxCapacity: 20,
        createdById: eur,
      },
    });
    roomId = room.id;

    await owe(eur, student.id, room.id);
    await owe(gbp, student.id, room.id);

    // Warm both routes: `next dev` compiles a page lazily on its first request.
    await fetch(`${BASE_URL}/settings/payments`, { headers: cookie(tokenOf('eur')) }).catch(() => {});
    await fetch(`${BASE_URL}/students/${student.id}`, { headers: cookie(tokenOf('eur')) }).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    if (studentId) {
      await prisma.payment.deleteMany({ where: { registration: { studentId } } });
      await prisma.registration.deleteMany({ where: { studentId } });
    }
    if (teacherIds.length > 0) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    if (studentId) await prisma.student.deleteMany({ where: { id: studentId } });
    if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  const overview = async (tag: 'eur' | 'gbp' | 'empty'): Promise<string> => {
    const res = await fetch(`${BASE_URL}/settings/payments`, { headers: cookie(tokenOf(tag)) });
    expect(res.status).toBe(200);
    return normalise(await res.text());
  };

  const studentPage = async (tag: 'eur' | 'gbp'): Promise<string> => {
    const res = await fetch(`${BASE_URL}/students/${studentId}`, { headers: cookie(tokenOf(tag)) });
    expect(res.status).toBe(200);
    return normalise(await res.text());
  };

  it('payments overview: each card shows one total per currency, never their sum', async () => {
    const html = await overview('eur');

    expect(testIdTexts(html, 'outstanding-total')).toEqual(['€20.00', '£7.00']);
    expect(testIdTexts(html, 'received-total')).toEqual(['€5.00', '£4.00']);
    expect(html).not.toContain('27.00');
    expect(html).not.toContain('9.00');
  });

  it('payments overview: each row shows its own class’s currency', async () => {
    const html = await overview('eur');

    expect(html).toContain('<span class="type-number text-brown">£7.00</span>');
    expect(html).not.toContain('<span class="type-number text-brown">€7.00</span>');
    expect(html).toContain('<span class="type-number">£4.00</span>');
    expect(html).not.toContain('<span class="type-number">€4.00</span>');
  });

  it('payments overview: a GBP teacher sees GBP first', async () => {
    const html = await overview('gbp');

    expect(testIdTexts(html, 'outstanding-total')).toEqual(['£7.00', '€20.00']);
    expect(testIdTexts(html, 'received-total')).toEqual(['£4.00', '€5.00']);
  });

  it('payments overview: a GBP teacher with no payments sees £0.00', async () => {
    const html = await overview('empty');

    expect(testIdTexts(html, 'outstanding-total')).toEqual(['£0.00']);
    expect(testIdTexts(html, 'received-total')).toEqual(['£0.00']);
  });

  it('student detail: the archive offer carries one total per currency, never their sum', async () => {
    const html = await studentPage('eur');

    // Rendered only when the confirm opens, so it is read from the props the
    // server hands `ArchiveStudentButton`.
    expect(html).toContain('"totals":[{"currency":"EUR","cents":2000},{"currency":"GBP","cents":700}]');
    expect(html).not.toContain('"cents":2700');
  });

  it('student detail: a GBP teacher’s archive offer puts GBP first', async () => {
    const html = await studentPage('gbp');

    expect(html).toContain('"totals":[{"currency":"GBP","cents":700},{"currency":"EUR","cents":2000}]');
  });

  it('student detail: each payment row shows its own class’s currency', async () => {
    const html = await studentPage('eur');

    expect(html).toContain('<p class="type-number text-brown">£7.00</p>');
    expect(html).not.toContain('<p class="type-number text-brown">€7.00</p>');
    expect(html).toContain('<p class="type-number text-brown">€12.00</p>');
  });
});

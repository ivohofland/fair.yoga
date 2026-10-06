import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma, type Currency } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { createClassFixture, createStudioClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * `/settings/reporting` groups every total by currency (#758): a teacher with
 * classes in two currencies sees one line per currency where a single total
 * stood, and never the numeric sum of the two. The teacher's own currency
 * leads, so the same mixed fixture is also seeded under a GBP teacher. A
 * figure with nothing in it reads zero in the teacher's currency: a GBP
 * teacher whose only completed class is a SEK studio class reads £0.00 for
 * their own classes and room costs.
 */
describe('GET /settings/reporting across currencies', () => {
  const teacherIds: string[] = [];
  const accountIds: string[] = [];
  let roomId: string | undefined;
  let mixedToken: string;
  let singleToken: string;
  let gbpMixedToken: string;
  let gbpStudioToken: string;

  const page = (token: string) => fetch(`${BASE_URL}/settings/reporting`, { headers: cookie(token) });

  async function makeTeacher(tag: string, currency: Currency = 'EUR'): Promise<{ id: string; token: string }> {
    const email = `repcur-${tag}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Cur',
        lastName: tag,
        email,
        account: { create: { email } },
        bio: 'Reporting currency test',
        pageSlug: `repcur-${tag}-${suffix}`,
        currency,
      },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    return { id: teacher.id, token: await seedSession(prisma, teacher.accountId) };
  }

  async function completedClass(
    teacherId: string,
    teacherRoomId: string,
    currency: 'EUR' | 'GBP',
    revenue: string,
    roomCost: string,
    day: number,
  ) {
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Currency Flow',
      date: new Date(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: new Prisma.Decimal(roomCost),
      totalRevenue: new Prisma.Decimal(revenue),
      totalStudents: 1,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
      currency,
    });
  }

  beforeAll(async () => {
    await prisma.$connect();
    const mixed = await makeTeacher('mixed');
    const single = await makeTeacher('single');
    const gbpMixed = await makeTeacher('gbpmixed', 'GBP');
    const gbpStudio = await makeTeacher('gbpstudio', 'GBP');
    mixedToken = mixed.token;
    singleToken = single.token;
    gbpMixedToken = gbpMixed.token;
    gbpStudioToken = gbpStudio.token;

    const room = await prisma.room.create({
      data: {
        venueName: 'Currency Hall',
        address: `${suffix} Cur St`,
        city: 'Amsterdam',
        postcode: '1000CU',
        roomName: 'Main Room',
        maxCapacity: 20,
        createdById: mixed.id,
      },
    });
    roomId = room.id;
    const mixedRoom = await prisma.teacherRoom.create({
      data: { teacherId: mixed.id, roomId: room.id, capacityOverride: 15, rentalRate: 10 },
    });
    const singleRoom = await prisma.teacherRoom.create({
      data: { teacherId: single.id, roomId: room.id, capacityOverride: 15, rentalRate: 10 },
    });
    const gbpMixedRoom = await prisma.teacherRoom.create({
      data: { teacherId: gbpMixed.id, roomId: room.id, capacityOverride: 15, rentalRate: 10 },
    });

    // EUR: 85.00 - 25.00 = 60.00 earned; GBP: 47.00 - 12.00 = 35.00 earned. Sum would be 95.00.
    async function mixedFixture(teacherId: string, teacherRoomId: string) {
      await completedClass(teacherId, teacherRoomId, 'EUR', '85.00', '25.00', 10);
      await completedClass(teacherId, teacherRoomId, 'GBP', '47.00', '12.00', 11);
      await createStudioClassFixture(prisma, {
        teacherId,
        classType: 'Studio GBP',
        location: 'Somewhere',
        date: new Date('2026-08-12T00:00:00.000Z'),
        startTime: hhmmToTime('10:00'),
        durationMinutes: 60,
        hourlyRate: new Prisma.Decimal('20.00'),
        studentCount: 3,
        currency: 'GBP',
      });
    }
    await mixedFixture(mixed.id, mixedRoom.id);
    await mixedFixture(gbpMixed.id, gbpMixedRoom.id);
    await createStudioClassFixture(prisma, {
      teacherId: gbpStudio.id,
      classType: 'Studio SEK',
      location: 'Somewhere',
      date: new Date('2026-08-12T00:00:00.000Z'),
      startTime: hhmmToTime('10:00'),
      durationMinutes: 60,
      hourlyRate: new Prisma.Decimal('20.00'),
      studentCount: 3,
      currency: 'SEK',
    });

    await completedClass(single.id, singleRoom.id, 'EUR', '85.00', '25.00', 10);
    await completedClass(single.id, singleRoom.id, 'EUR', '40.00', '10.00', 11);

    await fetch(`${BASE_URL}/settings/reporting`, { headers: cookie(mixedToken) }).catch(() => {});
  }, 30_000);

  afterAll(async () => {
    if (teacherIds.length > 0) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomId) await prisma.room.delete({ where: { id: roomId } });
    if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('shows one total per currency and never their sum', async () => {
    const res = await page(mixedToken);
    expect(res.status).toBe(200);
    const html = await res.text();

    // 60.00 EUR + (35.00 + 20.00) GBP
    expect(html).toContain('€60.00');
    expect(html).toContain('£55.00');
    expect(html).not.toContain('115.00');
    // Class earnings 60 + 35 and room costs 25 + 12 are never added across.
    expect(html).not.toContain('95.00');
    expect(html).not.toContain('37.00');
    expect(html).toContain('£35.00');
    expect(html).toContain('£12.00');
    expect(html).toContain('€25.00');
  });

  it('puts the teacher currency first in the headline total', async () => {
    const html = await (await page(mixedToken)).text();
    const lines = [...html.matchAll(/data-testid="report-total"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(lines).toEqual(['€60.00', '£55.00']);
  });

  it('puts a GBP teacher\'s currency first in the headline total', async () => {
    const html = await (await page(gbpMixedToken)).text();
    const lines = [...html.matchAll(/data-testid="report-total"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(lines).toEqual(['£55.00', '€60.00']);
  });

  it('reads £0.00 for a GBP teacher\'s figure with nothing in it', async () => {
    const html = (await (await page(gbpStudioToken)).text()).replaceAll('<!-- -->', '');
    const figure = (label: string): string[] => {
      const at = html.indexOf(`>${label}</span>`);
      expect(at).toBeGreaterThan(-1);
      const lines = html.slice(at).match(/^>[^<]*<\/span><span class="flex flex-col items-end">((?:<span[^>]*>[^<]*<\/span>)*)<\/span>/);
      return [...(lines?.[1] ?? '').matchAll(/>([^<]*)</g)].map((m) => m[1] ?? '');
    };
    expect(figure('Your classes')).toEqual(['£0.00']);
    expect(figure('Room costs paid')).toEqual(['£0.00']);
    expect(figure('Studio classes')).toEqual(['SEK 20.00']);
  });

  it('renders exactly one headline total for a single-currency teacher', async () => {
    const html = await (await page(singleToken)).text();
    const lines = [...html.matchAll(/data-testid="report-total"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(lines).toEqual(['€90.00']);
  });
});

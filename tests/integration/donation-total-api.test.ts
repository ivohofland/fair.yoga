import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, cookie, freshIp, uniqueSuffix, seedSession } from '../helpers';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();

type TeacherFixture = { id: string; accountId: string; teacherRoomId: string };

/**
 * `PUT /api/classes/[id]/donation-total` (#912). Each refusal case differs from
 * the eligible class in one condition, except the cancelled one: a completed
 * class cannot be cancelled (`CalendarEntry_not_cancelled_and_completed`), so
 * that fixture is an open class with `cancelledAt`.
 */
describe('recording a donation total (#912)', () => {
  const accountIds: string[] = [];
  const teacherIds: string[] = [];
  const roomIds: string[] = [];
  let ownerToken = '';
  let otherToken = '';
  const ids = { completedDonation: '', inProgressDonation: '', completedTiered: '', cancelledDonation: '' };

  async function makeTeacher(key: string): Promise<TeacherFixture> {
    const email = `dtotal-${key}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: `Total${key}`, lastName: 'Teacher', email, bio: 'Donation total fixture',
        pageSlug: `dtotal-${key}-${suffix}`, defaultTimezone: 'UTC', currency: 'EUR',
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    const room = await prisma.room.create({
      data: {
        venueName: 'Total Studio', address: `${suffix} ${key} St`, city: 'Amsterdam',
        postcode: '1000AA', roomName: 'Hall', maxCapacity: 20, createdById: teacher.id,
      },
    });
    roomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 25 },
    });
    return { ...teacher, teacherRoomId: teacherRoom.id };
  }

  let dayOffset = 0;
  async function makeClass(
    teacher: TeacherFixture,
    o: { pricingMode: 'donation' | 'tiered'; status: 'completed' | 'in_progress' | 'open'; cancelled?: boolean },
  ): Promise<string> {
    dayOffset += 1;
    const tiered = o.pricingMode === 'tiered';
    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacher.teacherRoomId,
      classType: `Total ${dayOffset} ${suffix}`,
      date: new Date(Date.UTC(2026, 5, dayOffset)),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: tiered ? 20 : 0,
      minRate: tiered ? 10 : 0,
      targetRate: tiered ? 20 : 0,
      minStudents: 1,
      maxStudents: 10,
      status: o.status,
      pricingMode: o.pricingMode,
      ...(o.cancelled ? { cancelledAt: new Date('2026-05-31T12:00:00.000Z') } : {}),
    });
    return cls.id;
  }

  const put = (token: string, id: string, body: unknown) =>
    fetch(`${BASE_URL}/api/classes/${id}/donation-total`, {
      method: 'PUT',
      headers: { ...cookie(token), ...freshIp(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const stored = async (id: string) =>
    (await prisma.class.findUniqueOrThrow({ where: { id } })).donationTotal;

  beforeAll(async () => {
    await prisma.$connect();
    const owner = await makeTeacher('owner');
    const other = await makeTeacher('other');
    ownerToken = await seedSession(prisma, owner.accountId);
    otherToken = await seedSession(prisma, other.accountId);
    ids.completedDonation = await makeClass(owner, { pricingMode: 'donation', status: 'completed' });
    ids.inProgressDonation = await makeClass(owner, { pricingMode: 'donation', status: 'in_progress' });
    ids.completedTiered = await makeClass(owner, { pricingMode: 'tiered', status: 'completed' });
    ids.cancelledDonation = await makeClass(owner, { pricingMode: 'donation', status: 'open', cancelled: true });
    // `next dev` compiles a route on its first request.
    await put(ownerToken, 'warm-up', { amount: 1 }).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    if (teacherIds.length > 0) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomIds.length > 0) await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    if (teacherIds.length > 0) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('(#912) records, answers unchanged for the same amount, and clears back to null', async () => {
    await expectApplied(await put(ownerToken, ids.completedDonation, { amount: 84.5 }));
    expect((await stored(ids.completedDonation))?.toString()).toBe('84.5');
    await expectUnchanged(await put(ownerToken, ids.completedDonation, { amount: 84.5 }));
    await expectApplied(await put(ownerToken, ids.completedDonation, { amount: null }));
    expect(await stored(ids.completedDonation)).toBeNull();
    await expectUnchanged(await put(ownerToken, ids.completedDonation, { amount: null }));
  });

  it('(#912) records 0, which is not the same as not recorded', async () => {
    await expectApplied(await put(ownerToken, ids.completedDonation, { amount: 0 }));
    expect((await stored(ids.completedDonation))?.toString()).toBe('0');
  });

  it("(#912) answers 403 for another teacher's class, like the sibling class routes", async () => {
    const before = (await stored(ids.completedDonation))?.toString() ?? null;
    const res = await put(otherToken, ids.completedDonation, { amount: 1 });
    expect(res.status).toBe(403);
    expect((await stored(ids.completedDonation))?.toString() ?? null).toBe(before);
  });

  it('(#912) answers 404 for a class that does not exist', async () => {
    await expectRefusal(await put(ownerToken, 'no-such-class', { amount: 1 }), 'NOT_FOUND');
  });

  it.each([
    ['cancelledDonation', 'CLASS_CANCELLED'],
    ['completedTiered', 'DONATION_CLASS_REQUIRED'],
    ['inProgressDonation', 'CLASS_NOT_COMPLETED'],
  ] as const)('(#912) %s answers %s', async (key, code) => {
    await expectRefusal(await put(ownerToken, ids[key], { amount: 1 }), code);
    expect(await stored(ids[key])).toBeNull();
  });

  it('(#912) refuses a negative amount with 400', async () => {
    expect((await put(ownerToken, ids.completedDonation, { amount: -1 })).status).toBe(400);
  });
});

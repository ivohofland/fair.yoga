import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BASE_URL, cookie, freshIp, seedSession, uniqueSuffix, teardownStudent, teardownTeacher } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { fillSeats } from '../waitlist-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();

/** A date `days` ahead at UTC midnight, the shape `CalendarEntry.date` stores. */
function daysAhead(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** `#910`: a private class is left off `/[slug]` and booked by its own link. */
describe('private classes — public side', () => {
  const slug = `private-classes-${suffix}`;
  const firstName = 'Privy';
  let teacherId = '';
  let teacherAccountId = '';
  let roomId = '';
  let teacherRoomId = '';
  let publicClassId = '';
  let privateClassId = '';
  let fullPrivateClassId = '';
  let studentId = '';
  let studentAccountId = '';
  let studentToken = '';
  let waiterId = '';
  let waiterAccountId = '';
  let waiterToken = '';
  let fillerIds: string[] = [];

  beforeAll(async () => {
    const email = `private-classes-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName,
        lastName: 'Teacher',
        email,
        bio: 'Private classes fixture teacher',
        pageSlug: slug,
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Private Studio',
        address: `${suffix} Private St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        roomName: 'Hall',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    teacherRoomId = (
      await prisma.teacherRoom.create({
        data: { teacherId, roomId, capacityOverride: 15, rentalRate: 25 },
      })
    ).id;

    const make = (classType: string, days: number, isPrivate: boolean, maxStudents: number) =>
      createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType,
        date: daysAhead(days),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents,
        status: 'open',
        isPrivate,
      });
    publicClassId = (await make('Public Fixture', 10, false, 10)).id;
    privateClassId = (await make('Private Fixture', 11, true, 10)).id;
    fullPrivateClassId = (await make('Full Private Fixture', 12, true, 1)).id;
    fillerIds = await fillSeats(prisma, fullPrivateClassId, 1, `private-${suffix}`);

    const mkStudent = async (tag: string) => {
      const studentEmail = `private-classes-${tag}-${suffix}@test.local`;
      const s = await prisma.student.create({
        data: {
          firstName: 'Priv',
          lastName: tag,
          email: studentEmail,
          claimedAt: new Date(),
          incomeTier: 3,
          account: { create: { email: studentEmail } },
        },
        select: { id: true, accountId: true },
      });
      const accountId = s.accountId as string;
      return { id: s.id, accountId, token: await seedSession(prisma, accountId) };
    };
    const student = await mkStudent('student');
    studentId = student.id;
    studentAccountId = student.accountId;
    studentToken = student.token;
    const waiter = await mkStudent('waiter');
    waiterId = waiter.id;
    waiterAccountId = waiter.accountId;
    waiterToken = waiter.token;

    // `next dev` compiles each route lazily on its first request.
    await fetch(`${BASE_URL}/${slug}`).catch(() => {});
    await fetch(`${BASE_URL}/${slug}/book/${privateClassId}`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: [publicClassId, privateClassId, fullPrivateClassId] } } });
    await prisma.registration.deleteMany({ where: { classId: { in: [publicClassId, privateClassId, fullPrivateClassId] } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    for (const id of fillerIds) await teardownStudent(prisma, id);
    await teardownStudent(prisma, studentId, studentAccountId);
    await teardownStudent(prisma, waiterId, waiterAccountId);
    await teardownTeacher(prisma, teacherId, teacherAccountId);
    await prisma.$disconnect();
  });

  it('/[slug] lists the public class and leaves out the private one', async () => {
    const html = await (await fetch(`${BASE_URL}/${slug}`, { headers: freshIp() })).text();
    expect(html).toContain(`/${slug}/book/${publicClassId}`);
    expect(html).not.toContain(`/${slug}/book/${privateClassId}`);
  });

  it('the booking page renders a private class, noindex, with the shared-by-link caption', async () => {
    const res = await fetch(`${BASE_URL}/${slug}/book/${privateClassId}`, { headers: freshIp() });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex"/>');
    // React separates adjacent text nodes with an empty comment and escapes the apostrophe.
    const text = html.replaceAll('<!-- -->', '');
    expect(text).toContain(`Shared by link — not on ${firstName}&#x27;s public schedule.`);
  });

  it('the booking page for a public class has no noindex and no caption', async () => {
    const html = await (await fetch(`${BASE_URL}/${slug}/book/${publicClassId}`, { headers: freshIp() })).text();
    expect(html).not.toMatch(/<meta name="robots" content="noindex/);
    expect(html).not.toContain('Shared by link');
  });

  it('a student books a private class through POST /api/registrations', async () => {
    const res = await fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken), ...freshIp() },
      body: JSON.stringify({ classId: privateClassId }),
    });
    expect(res.status).toBe(201);
  });

  it('a full private class still takes a waitlist join', async () => {
    const res = await fetch(`${BASE_URL}/api/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(waiterToken), ...freshIp() },
      body: JSON.stringify({ classId: fullPrivateClassId }),
    });
    expect(res.status).toBe(201);
  });

  it('a booked private class still renders for its student', async () => {
    const res = await fetch(`${BASE_URL}/${slug}/book/${privateClassId}`, {
      headers: { ...cookie(studentToken), ...freshIp() },
    });
    expect(res.status).toBe(200);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { BASE_URL, cookie, uniqueSuffix, seedSession, teardownStudent, teardownTeacher } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { createPrismaClient } from '@/lib/prisma-client';

const prisma = createPrismaClient();
const suffix = uniqueSuffix();

/**
 * #911: an online class's video link reaches the students booked on it, under
 * `/bookings`, and no one else. The public pages are checked as the server
 * sends them — the HTML document, whose inline flight data carries every
 * client component's props, and the RSC payload a client-side navigation
 * fetches — so a link handed to a client component and never rendered is
 * still caught.
 */
describe('an online class’s video link stays with its booked students (#911)', () => {
  // `.invalid` is reserved (RFC 2606): this string can only come from this fixture.
  const LINK = `https://example.invalid/online-911-${crypto.randomBytes(8).toString('hex')}`;
  const slug = `online-link-${suffix}`;
  let teacherId = '';
  let classId = '';
  const students: { id: string; accountId: string; token: string }[] = [];
  let registered: { id: string; accountId: string; token: string };
  let waitlisted: { id: string; accountId: string; token: string };

  async function makeStudent(label: string) {
    const email = `online-link-${label}-${suffix}@test.local`;
    const s = await prisma.student.create({
      data: {
        firstName: 'Online',
        lastName: label,
        email,
        claimedAt: new Date(),
        incomeTier: 3,
        tierSelectedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    const accountId = s.accountId as string;
    const out = { id: s.id, accountId, token: await seedSession(prisma, accountId) };
    students.push(out);
    return out;
  }

  /** The HTML document and the RSC payload of `path`, as one string. */
  async function served(path: string, token?: string): Promise<string> {
    const headers = token === undefined ? {} : cookie(token);
    const html = await fetch(`${BASE_URL}${path}`, { headers });
    expect(html.status).toBe(200);
    // Next answers an RSC request with a redirect to a cache-busted URL of
    // the same path; followed, it is the flight payload of that path itself.
    const rsc = await fetch(`${BASE_URL}${path}`, { headers: { ...headers, RSC: '1' } });
    expect(rsc.status).toBe(200);
    expect(new URL(rsc.url).pathname).toBe(path);
    expect(rsc.headers.get('content-type')).toContain('text/x-component');
    return `${await html.text()}\n${await rsc.text()}`;
  }

  beforeAll(async () => {
    const email = `online-link-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Online',
        lastName: 'Teacher',
        email,
        bio: 'Online link privacy fixture',
        pageSlug: slug,
        defaultTimezone: 'UTC',
        account: { create: { email } },
      },
    });
    teacherId = teacher.id;

    const day = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: null,
      format: 'online',
      videoUrl: LINK,
      classType: `Online Flow ${suffix}`,
      date: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())),
      startTime: hhmmToTime('18:00'),
      durationMinutes: 60,
      roomCost: 0,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 1,
      status: 'open',
    });
    classId = cls.id;

    registered = await makeStudent('registered');
    waitlisted = await makeStudent('waitlisted');
    await prisma.registration.create({ data: { classId, studentId: registered.id, status: 'registered', tierAtBooking: 3 } });
    await prisma.waitlistEntry.create({ data: { classId, studentId: waitlisted.id, position: 1 } });
    for (const s of [registered, waitlisted]) {
      await prisma.teacherStudent.create({ data: { teacherId, studentId: s.id } });
    }

    // Warm the routes: `next dev` compiles each page on its first request.
    for (const path of [`/${slug}`, `/${slug}/book/${classId}`, '/bookings']) {
      await fetch(`${BASE_URL}${path}`, { headers: cookie(registered.token) }).catch(() => {});
    }
  }, 60_000);

  afterAll(async () => {
    const ids = students.map((s) => s.id);
    await prisma.notification.deleteMany({ where: { recipientId: { in: ids } } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.registration.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    for (const s of students) await teardownStudent(prisma, s.id, s.accountId);
    await teardownTeacher(prisma, teacherId);
    await prisma.$disconnect();
  });

  it('keeps the link off the teacher’s public page, which still says Online', async () => {
    const body = await served(`/${slug}`);
    expect(body).toContain(`Online Flow ${suffix}`);
    expect(body).toContain('Online');
    expect(body).not.toContain(LINK);
  });

  it('keeps the link off the booking page for an anonymous visitor', async () => {
    const body = await served(`/${slug}/book/${classId}`);
    expect(body).toContain('Online');
    expect(body).not.toContain(LINK);
  });

  it('keeps the link off the booking page for the booked student, and points them to their booking', async () => {
    const body = await served(`/${slug}/book/${classId}`, registered.token);
    expect(body).toContain('booked for this class');
    expect(body).toContain('/bookings');
    expect(body).not.toContain(LINK);
  });

  it('keeps the link off the booking page for a waitlisted student', async () => {
    const body = await served(`/${slug}/book/${classId}`, waitlisted.token);
    expect(body).toContain('on the waitlist');
    expect(body).not.toContain(LINK);
  });

  it('shows the booked student the link under /bookings', async () => {
    const body = await served('/bookings', registered.token);
    expect(body).toContain(`href="${LINK}"`);
    expect(body).toContain(`Online Flow ${suffix}`);
    expect(body).toContain('Join the class');
  });

  it('never shows the waitlisted student the link under /bookings', async () => {
    const body = await served('/bookings', waitlisted.token);
    expect(body).toContain(`Online Flow ${suffix}`);
    expect(body).not.toContain(LINK);
    expect(body).not.toContain('Join the class');
  });
});

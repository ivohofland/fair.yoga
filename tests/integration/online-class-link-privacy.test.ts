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
  let registrationId = '';
  let teacherToken = '';
  // Fixtures the API tests act on: a class with room (`openClassId`) for a
  // booking made through the API, a full one (`fullClassId`) for a waitlist
  // join, and one whose link the teacher edits while a student listens
  // (`streamClassId`).
  let openClassId = '';
  let fullClassId = '';
  let streamClassId = '';
  let booker: { id: string; accountId: string; token: string };
  let joiner: { id: string; accountId: string; token: string };
  let listener: { id: string; accountId: string; token: string };

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

  /** One more online class of the same teacher, holding `LINK`. */
  async function makeClass(dayOffset: number, label: string, maxStudents: number) {
    const day = new Date(Date.now() + dayOffset * 24 * 60 * 60 * 1000);
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: null,
      format: 'online',
      videoUrl: LINK,
      classType: `Online ${label} ${suffix}`,
      date: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())),
      startTime: hhmmToTime('18:00'),
      durationMinutes: 60,
      roomCost: 0,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents,
      status: 'open',
    });
    return cls.id;
  }

  /** A call as `token`'s holder; its status and whole body, as text. */
  async function call(method: string, path: string, token: string, body?: object) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { ...cookie(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
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
    teacherToken = await seedSession(prisma, teacher.accountId as string);

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
    const booking = await prisma.registration.create({ data: { classId, studentId: registered.id, status: 'registered', tierAtBooking: 3 } });
    registrationId = booking.id;
    await prisma.waitlistEntry.create({ data: { classId, studentId: waitlisted.id, position: 1 } });

    booker = await makeStudent('booker');
    joiner = await makeStudent('joiner');
    listener = await makeStudent('listener');
    const holder = await makeStudent('holder');
    openClassId = await makeClass(8, 'Open', 5);
    fullClassId = await makeClass(9, 'Full', 1);
    streamClassId = await makeClass(10, 'Stream', 5);
    await prisma.registration.create({ data: { classId: fullClassId, studentId: holder.id, status: 'registered', tierAtBooking: 3 } });
    await prisma.registration.create({ data: { classId: streamClassId, studentId: listener.id, status: 'registered', tierAtBooking: 3 } });
    // The inbox as it stands once the link has been added: one row about the
    // class for the booked student, one about a seat for the waitlisted one.
    await prisma.notification.createMany({
      data: [
        { recipientType: 'student', recipientId: registered.id, type: 'video_link_updated', title: 'Video link added', body: 'Your teacher added the link.', relatedClassId: classId },
        { recipientType: 'student', recipientId: waitlisted.id, type: 'spot_available', title: 'A spot opened', body: 'A seat is free.', relatedClassId: classId },
      ],
    });
    for (const s of [registered, waitlisted, booker, joiner, listener, holder]) {
      await prisma.teacherStudent.create({ data: { teacherId, studentId: s.id } });
    }

    // Warm the routes: `next dev` compiles each page on its first request.
    for (const path of [`/${slug}`, `/${slug}/book/${classId}`, '/bookings', '/api/notifications', `/api/registrations/${registrationId}`]) {
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

  it.each([
    ['the booked student', () => registered.token],
    ['the waitlisted student', () => waitlisted.token],
  ])('keeps the link off the teacher’s public page for %s', async (_who, token) => {
    const body = await served(`/${slug}`, token());
    expect(body).toContain(`Online Flow ${suffix}`);
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

  describe('over the API', () => {
    it('keeps the link out of a booking made through the API, and out of its re-read', async () => {
      const made = await call('POST', '/api/registrations', booker.token, { classId: openClassId });
      expect(made.status).toBe(201);
      expect(made.text).not.toContain(LINK);
      const { data: { id } } = JSON.parse(made.text) as { data: { id: string } };

      const read = await call('GET', `/api/registrations/${id}`, booker.token);
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(LINK);

      const again = await call('POST', '/api/registrations', booker.token, { classId: openClassId });
      expect(again.text).not.toContain(LINK);
    });

    it('keeps the link out of the booked student’s own booking and of a repeated booking', async () => {
      const read = await call('GET', `/api/registrations/${registrationId}`, registered.token);
      expect(read.status).toBe(200);
      expect(read.text).not.toContain(LINK);
      const again = await call('POST', '/api/registrations', registered.token, { classId });
      expect(again.text).not.toContain(LINK);
    });

    it('keeps the link out of every answer the waitlisted student can get about the class', async () => {
      const refusedBooking = await call('POST', '/api/registrations', waitlisted.token, { classId });
      const rejoin = await call('POST', '/api/waitlist', waitlisted.token, { classId });
      const claim = await call('POST', '/api/waitlist/claim', waitlisted.token, { classId });
      const foreign = await call('GET', `/api/registrations/${registrationId}`, waitlisted.token);
      for (const answer of [refusedBooking, rejoin, claim, foreign]) {
        expect(answer.status).toBeGreaterThanOrEqual(200);
        expect(answer.text).not.toContain(LINK);
      }
    });

    it('keeps the link out of a waitlist join, a claim attempt and a leave', async () => {
      const joined = await call('POST', '/api/waitlist', joiner.token, { classId: fullClassId });
      expect(joined.status).toBe(201);
      expect(joined.text).not.toContain(LINK);
      const { data: { id } } = JSON.parse(joined.text) as { data: { id: string } };

      const claim = await call('POST', '/api/waitlist/claim', joiner.token, { classId: fullClassId });
      expect(claim.text).not.toContain(LINK);

      const left = await call('DELETE', `/api/waitlist/${id}`, joiner.token);
      expect(left.status).toBe(200);
      expect(left.text).not.toContain(LINK);
    });

    it.each([
      ['booked', () => registered.token],
      ['waitlisted', () => waitlisted.token],
    ])('keeps the link out of the %s student’s inbox and data export', async (_who, token) => {
      const inbox = await call('GET', '/api/notifications', token());
      expect(inbox.status).toBe(200);
      expect(inbox.text).toContain(`${classId}`);
      expect(inbox.text).not.toContain(LINK);

      const exported = await call('GET', '/api/account/export', token());
      expect(exported.status).toBe(200);
      expect(exported.text).not.toContain(LINK);
    });

    it('keeps the link out of the live stream when the teacher changes it', async () => {
      const ac = new AbortController();
      const res = await fetch(`${BASE_URL}/api/notifications/stream`, { headers: cookie(listener.token), signal: ac.signal });
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let seen = '';
      const drain = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            seen += decoder.decode(value, { stream: true });
          }
          // eslint-disable-next-line no-restricted-syntax -- the read rejects when the test aborts the stream
        } catch {
          return;
        }
      })();
      try {
        const changed = `${LINK}-v2`;
        const edit = await call('PUT', `/api/classes/${streamClassId}`, teacherToken, { videoUrl: changed });
        expect(edit.status).toBe(200);
        // The frame for the notice is the proof the bus carried something.
        const deadline = Date.now() + 10_000;
        while (!seen.includes('data: ') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        expect(seen).toContain('video_link_updated');
        expect(seen).not.toContain('example.invalid');
      } finally {
        ac.abort();
        await drain;
      }
    });
  });
});

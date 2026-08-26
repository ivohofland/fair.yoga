import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { ANNOUNCEMENT_DEDUPE_WINDOW_MS } from '@/lib/db-locks';
import { hhmmToTime } from '@/lib/time-of-day';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
let otherTeacherId: string;
let roomId: string;
let class1Id: string;
let class2Id: string;
let class3Id: string;
let foreignClassId: string;
let s1Id: string;
let s2Id: string;
let s3Id: string;

async function sendAnnouncement(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE_URL}/api/announcements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
    body: JSON.stringify(body),
  });
}

function announcementNotifications(where: Record<string, unknown>) {
  return prisma.notification.findMany({
    where: {
      type: 'announcement',
      recipientId: { in: [s1Id, s2Id, s3Id] },
      ...where,
    },
  });
}

describe('POST /api/announcements', () => {
  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Announce',
        lastName: 'Teacher',
        email: `announce-teacher-${suffix}@test.local`,
        account: { create: { email: `announce-teacher-${suffix}@test.local` } },
        bio: 'Announcement fixtures',
        pageSlug: `announce-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    const other = await prisma.teacher.create({
      data: {
        firstName: 'Foreign',
        lastName: 'Teacher',
        email: `announce-other-${suffix}@test.local`,
        account: { create: { email: `announce-other-${suffix}@test.local` } },
        bio: 'Ownership fixture',
        pageSlug: `announce-other-${suffix}`,
      },
    });
    otherTeacherId = other.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Announce Studio',
        address: `${suffix} Announce St`,
        city: 'Amsterdam',
        postcode: '1111AN',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });
    const otherTeacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    async function makeClass(ownerTeacherId: string, ownerRoomId: string, daysAhead: number) {
      const date = new Date();
      date.setDate(date.getDate() + daysAhead);
      date.setUTCHours(0, 0, 0, 0);
      return prisma.class.create({
        data: {
          teacherId: ownerTeacherId,
          teacherRoomId: ownerRoomId,
          classType: 'Vinyasa',
          date,
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'open',
        },
      });
    }
    class1Id = (await makeClass(teacherId, teacherRoom.id, 7)).id;
    class2Id = (await makeClass(teacherId, teacherRoom.id, 14)).id;
    class3Id = (await makeClass(teacherId, teacherRoom.id, 21)).id;
    foreignClassId = (await makeClass(otherTeacherId, otherTeacherRoom.id, 7)).id;

    async function makeStudent(name: string) {
      const s = await prisma.student.create({
        data: {
          firstName: name,
          lastName: 'Student',
          email: `announce-${name.toLowerCase()}-${suffix}@test.local`,
          incomeTier: 3,
        },
      });
      return s.id;
    }
    s1Id = await makeStudent('Dedup');
    s2Id = await makeStudent('Muted');
    s3Id = await makeStudent('Cancelled');

    async function register(classId: string, studentId: string, status: 'registered' | 'cancelled') {
      await prisma.registration.create({
        data: { classId, studentId, status, tierAtBooking: 3 },
      });
    }
    // S1: classes 1 + 2 (the dedup case).
    await register(class1Id, s1Id, 'registered');
    await register(class2Id, s1Id, 'registered');
    // S2: classes 1 + 3, but muted for teacher A.
    await register(class1Id, s2Id, 'registered');
    await register(class3Id, s2Id, 'registered');
    await prisma.studentPrivacy.create({
      data: { studentId: s2Id, teacherId, receiveComms: false },
    });
    // S3: cancelled in class 1 only.
    await register(class1Id, s3Id, 'cancelled');

    teacherToken = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    if (teacherAccountId) {
      await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    }
    const studentIds = [s1Id, s2Id, s3Id].filter(Boolean);
    if (studentIds.length) {
      await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
    }
    if (teacherId) await prisma.announcement.deleteMany({ where: { teacherId } });
    const classIds = [class1Id, class2Id, class3Id, foreignClassId].filter(Boolean);
    if (classIds.length) await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (studentIds.length) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  it('class-scoped send reaches non-cancelled, unmuted registrants only', async () => {
    const res = await sendAnnouncement({ classId: class1Id, message: 'Bring a blanket.' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1); // S1 only: S2 muted, S3 cancelled

    const rows = await announcementNotifications({ relatedClassId: class1Id });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientId).toBe(s1Id);
    // The user-visible payload, not just the row count.
    expect(rows[0]!.title).toBe('New announcement');
    expect(rows[0]!.body).toBe('Bring a blanket.');
  });

  it('rejects a send without a message', async () => {
    const res = await sendAnnouncement({ classId: class1Id });
    expect(res.status).toBe(400);
  });

  it('all-students send deduplicates across classes and honors the mute', async () => {
    const before = new Date();
    const res = await sendAnnouncement({ message: 'Studio closed next week.' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1); // S1 deduped; S2 muted; S3 cancelled-only

    const rows = await announcementNotifications({ createdAt: { gt: before } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientId).toBe(s1Id);
  });

  it("rejects another teacher's class", async () => {
    const before = new Date();
    const res = await sendAnnouncement({ classId: foreignClassId, message: 'Hijack attempt.' });
    expect(res.status).toBe(403);
    expect(await announcementNotifications({ createdAt: { gt: before } })).toHaveLength(0);
  });

  it('400 when every registrant is muted, and no Announcement row is written', async () => {
    const before = new Date();
    const res = await sendAnnouncement({ classId: class3Id, message: 'Nobody hears this.' });
    expect(res.status).toBe(400);
    expect(await announcementNotifications({ createdAt: { gt: before } })).toHaveLength(0);
    const records = await prisma.announcement.findMany({
      where: { teacherId, classId: class3Id },
    });
    expect(records).toHaveLength(0);
  });

  it('404 for an unknown class', async () => {
    const res = await sendAnnouncement({
      classId: '00000000-0000-4000-8000-000000000000',
      message: 'Ghost class.',
    });
    expect(res.status).toBe(404);
  });

  describe('is retry-safe against a duplicate send (#196)', () => {
    it('notifies each student once when the same announcement is sent twice at once', async () => {
      const message = `Race announcement ${suffix}`;

      // A plain `Promise.all` of two fetches serialises — the second request
      // lands after the first has committed, so the *sequential* compare
      // answers it and the lock is never the thing under test. The
      // deterministic lever (as in `payments-api.test.ts` and
      // `registrations-api.test.ts`): a second client holds the `Class` row
      // locked `FOR UPDATE` before either request runs. Both requests get past
      // the reads, into the transaction and past the compare — neither has
      // committed anything the other can see — and then park, because
      // inserting a `Notification` carrying `relatedClassId` takes `FOR KEY
      // SHARE` on that parent row (`docs/lock-order.md`, "the fourth path").
      const holder = new PrismaClient();
      let release!: () => void;
      let locked!: () => void;
      const released = new Promise<void>((r) => {
        release = r;
      });
      // The handshake, without which the lever is decorative: `$transaction`
      // returns before its callback has run, and a fresh `PrismaClient` has
      // to connect and start its engine first (50-200ms, measured), so both
      // requests could finish before the lock was ever taken — and the second
      // one would then be answered by the sequential compare rather than by
      // the advisory lock this test exists to hold. Same pattern, and the
      // same reason, as `registrations-api.test.ts`'s cancel race.
      const parked = new Promise<void>((r) => {
        locked = r;
      });
      const holding = holder.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${class1Id} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 20_000 },
      );
      await parked;

      const both = Promise.all([
        sendAnnouncement({ classId: class1Id, message }),
        sendAnnouncement({ classId: class1Id, message }),
      ]);

      // Long enough that both requests are in flight and parked, short enough
      // to stay well inside every transaction timeout involved.
      let settled = false;
      void both.then(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 1000));

      // The lever is asserted, not assumed: one request holds the advisory
      // slot and parks on the `Class` row (its `Notification` insert wants
      // `FOR KEY SHARE` on it), the other parks on the advisory slot. If
      // either had answered inside the second above, the interleaving under
      // test never happened and a green run would mean nothing.
      expect(settled).toBe(false);
      release();
      await holding;
      const [a, b] = await both;
      await holder.$disconnect();

      // Asserted first, deliberately: the fan-out is what a duplicate actually
      // costs, and it is the write that runs BEFORE the `Announcement` row.
      // With the announcement-row count first, moving the compare below the
      // fan-out reads as green — one row, every student notified twice.
      expect(await announcementNotifications({ body: message })).toHaveLength(1);

      // 201 created it, 200 suppressed it. Either request can win, so the
      // loser is identified rather than assumed.
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      const suppressed = a.status === 200 ? a : b;
      expect((await suppressed.json()).data.duplicateSuppressed).toBe(true);

      expect(await prisma.announcement.findMany({ where: { teacherId, message } })).toHaveLength(1);
    });

    it('suppresses an identical announcement resent within the window, and says so', async () => {
      const message = `Sequential dedupe ${suffix}`;
      expect((await sendAnnouncement({ classId: class1Id, message })).status).toBe(201);

      const second = await sendAnnouncement({ classId: class1Id, message });

      // Notifications before rows AND before the status, for the reason given
      // in the case above — the comment said so and the order did not.
      // Dropping the dedupe fails here, on "every student notified twice",
      // rather than on a 201 that reports only that a second send succeeded.
      expect(await announcementNotifications({ body: message })).toHaveLength(1);
      expect(await prisma.announcement.findMany({ where: { teacherId, message } })).toHaveLength(1);

      expect(second.status).toBe(200);
      const { data } = await second.json();
      // The teacher is told, rather than shown a success for a send that did
      // not happen. `recipientCount` is the FIRST send's, which is the honest
      // number: those students did receive it.
      expect(data.duplicateSuppressed).toBe(true);
      expect(data.recipientCount).toBeGreaterThan(0);
    });

    it('sends a genuinely later identical announcement', async () => {
      const message = `Window lapse ${suffix}`;
      expect((await sendAnnouncement({ classId: class1Id, message })).status).toBe(201);

      // Backdate the first past the window rather than sleeping two minutes.
      // `ANNOUNCEMENT_DEDUPE_WINDOW_MS` is imported rather than hard-coded, so
      // this cannot drift silently the day the window changes.
      await prisma.announcement.updateMany({
        where: { teacherId, message },
        data: { sentAt: new Date(Date.now() - ANNOUNCEMENT_DEDUPE_WINDOW_MS - 1000) },
      });

      expect((await sendAnnouncement({ classId: class1Id, message })).status).toBe(201);
      expect(await announcementNotifications({ body: message })).toHaveLength(2);
    });

    it('does not let an all-students announcement match a class-scoped one', async () => {
      const message = `Nullable classId ${suffix}`;
      expect((await sendAnnouncement({ classId: class1Id, message })).status).toBe(201);
      // No `classId` at all — a different announcement, and the case a Prisma
      // `where` given `undefined` silently widens to "every announcement this
      // teacher ever sent".
      expect((await sendAnnouncement({ message })).status).toBe(201);
      expect(await prisma.announcement.count({ where: { teacherId, message } })).toBe(2);
    });

    /**
     * The positive half of the nullable `classId`, and the half that was
     * missing: two identical ALL-STUDENTS sends must dedupe each other.
     *
     * The negative above only proves the two shapes do not collide, which a
     * dedupe that matches NOTHING when `classId` is null satisfies just as
     * well — `classId: { equals: undefined }`, an `if (classId)` guard around
     * the compare, a lock key that varies per request. Every other case in
     * this block sends `classId`, so nothing else in the suite would notice:
     * the all-students path would fan out twice, silently, for every teacher
     * who double-clicked Send on the message that goes to everyone.
     */
    it('suppresses an identical all-students resend inside the window', async () => {
      const message = `All-students dedupe ${suffix}`;
      expect((await sendAnnouncement({ message })).status).toBe(201);

      const second = await sendAnnouncement({ message });

      // Notifications first, as everywhere in this block: the doubled fan-out
      // is the cost, the status is only how it is reported.
      expect(await announcementNotifications({ body: message })).toHaveLength(1);
      expect(await prisma.announcement.count({ where: { teacherId, classId: null, message } }))
        .toBe(1);

      expect(second.status).toBe(200);
      expect((await second.json()).data.duplicateSuppressed).toBe(true);
    });
  });
});

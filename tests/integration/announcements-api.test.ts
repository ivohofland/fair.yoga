import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { ANNOUNCEMENT_DEDUPE_WINDOW_MS } from '@/services/announcements';
import { NO_RECIPIENTS_MESSAGE } from '@/app/api/announcements/shared';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
let otherTeacherId: string;
let otherTeacherAccountId = '';
let roomId: string;
let teacherRoomId: string;
let class1Id: string;
let class2Id: string;
let class3Id: string;
let foreignClassId: string;
let s1Id: string;
let s2Id: string;
let s3Id: string;
let s4Id: string;
let foreignStudentId: string;
let linkedOnlyId: string;

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
      recipientId: { in: [s1Id, s2Id, s3Id, s4Id, foreignStudentId].filter(Boolean) },
      ...where,
    },
  });
}


/**
 * One teacher, with a room, three classes and a roster, per call. The send
 * limiter lives in the shared server process and keeps its count across the
 * whole run, so a describe block that sends announcements owns its teacher
 * and stays within the hourly budget; `useWorld` gives it one.
 */
async function setupWorld(tag: string): Promise<void> {
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Announce',
      lastName: 'Teacher',
      email: `announce-${tag}-teacher-${suffix}@test.local`,
      account: { create: { email: `announce-${tag}-teacher-${suffix}@test.local` } },
      bio: 'Announcement fixtures',
      pageSlug: `announce-${tag}-teacher-${suffix}`,
    },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;
  const other = await prisma.teacher.create({
    data: {
      firstName: 'Foreign',
      lastName: 'Teacher',
      email: `announce-${tag}-other-${suffix}@test.local`,
      account: { create: { email: `announce-${tag}-other-${suffix}@test.local` } },
      bio: 'Ownership fixture',
      pageSlug: `announce-${tag}-other-${suffix}`,
    },
  });
  otherTeacherId = other.id;
  otherTeacherAccountId = other.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Announce Studio',
      address: `${suffix}-${tag} Announce St`,
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
  teacherRoomId = teacherRoom.id;
  const otherTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: otherTeacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
  });

  async function makeClass(ownerTeacherId: string, ownerRoomId: string, daysAhead: number) {
    const date = new Date();
    date.setDate(date.getDate() + daysAhead);
    date.setUTCHours(0, 0, 0, 0);
    return createClassFixture(prisma, {
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
        email: `announce-${tag}-${name.toLowerCase()}-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    return s.id;
  }
  s1Id = await makeStudent('Dedup');
  s2Id = await makeStudent('Muted');
  s3Id = await makeStudent('Cancelled');
  s4Id = await makeStudent('Second');
  foreignStudentId = await makeStudent('Foreign');
  // Linked as a CRM contact but never booked: not in the audience.
  linkedOnlyId = await makeStudent('Linked');
  await prisma.teacherStudent.create({ data: { teacherId, studentId: linkedOnlyId } });

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
  // S4: class 2 only, unmuted — the second selectable student.
  await register(class2Id, s4Id, 'registered');
  // Foreign: booked only with the other teacher.
  await register(foreignClassId, foreignStudentId, 'registered');

  teacherToken = await seedSession(prisma, teacherAccountId);
}

async function teardownWorld(): Promise<void> {
  const accountIds = [teacherAccountId, otherTeacherAccountId].filter(Boolean);
  if (accountIds.length) {
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  }
  const studentIds = [s1Id, s2Id, s3Id, s4Id, foreignStudentId, linkedOnlyId].filter(Boolean);
  if (studentIds.length) {
    await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
  }
  if (teacherId) await prisma.announcement.deleteMany({ where: { teacherId } });
  const classIds = [class1Id, class2Id, class3Id, foreignClassId].filter(Boolean);
  if (classIds.length) await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
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
}

function useWorld(tag: string): void {
  beforeAll(() => setupWorld(tag));
  afterAll(() => teardownWorld());
}


afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/announcements', () => {
  useWorld('basic');

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
    expect(data.recipientCount).toBe(2); // S1 (two classes, once) and S4; S2 muted; S3 cancelled-only

    const rows = await announcementNotifications({ createdAt: { gt: before } });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([s1Id, s4Id].sort());
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
    expect((await res.json()).error.message).toBe(NO_RECIPIENTS_MESSAGE.audience);
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

  /**
   * Two identical all-students sends notify each student once and write one
   * Announcement row. Every other case in this block sends a `classId`, so
   * this is the one that pins the all-students path against a double-click
   * on Send fanning out twice.
   */
  it('suppresses an identical all-students resend inside the window', async () => {
    const message = `All-students dedupe ${suffix}`;
    expect((await sendAnnouncement({ message })).status).toBe(201);

    const second = await sendAnnouncement({ message });

    // Notifications first, as everywhere in this block: the doubled fan-out
    // is the cost, the status is only how it is reported.
    expect(await announcementNotifications({ body: message })).toHaveLength(2); // S1 and S4, once each
    expect(await prisma.announcement.count({ where: { teacherId, classId: null, message } }))
      .toBe(1);

    expect(second.status).toBe(200);
    expect((await second.json()).data.duplicateSuppressed).toBe(true);
  });
});

describe('POST /api/announcements: is retry-safe against a duplicate send (#196)', () => {
  useWorld('dedupe');

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
    // not happen. `recipientCount` on a suppressed answer is the number of
    // requested students who already had it.
    expect(data.duplicateSuppressed).toBe(true);
    expect(data.recipientCount).toBe(1); // S1, the class's one reachable registrant
    expect(data.alreadyNotified).toBe(1);
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

  it('does not re-notify a class send\'s registrants on a same-message all-students send', async () => {
    const message = `Cross-scope dedupe ${suffix}`;
    expect((await sendAnnouncement({ classId: class1Id, message })).status).toBe(201);
    // Dedupe is per recipient and ignores scope: S1 was told by the class
    // send, so only S4 (not in class 1) is new to the all-students send.
    const second = await sendAnnouncement({ message });
    expect(second.status).toBe(201);
    const { data } = await second.json();
    expect(data.recipientCount).toBe(1);
    expect(data.alreadyNotified).toBe(1);
    const rows = await announcementNotifications({ body: message });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([s1Id, s4Id].sort());
    expect(await prisma.announcement.count({ where: { teacherId, message } })).toBe(2);
  });

  it("does not re-notify an all-students send's students on a same-message class send", async () => {
    const message = `Reverse cross-scope dedupe ${suffix}`;
    expect((await sendAnnouncement({ message })).status).toBe(201);
    // S1 is class 1's one reachable registrant and was told above, so the
    // class send has nobody new to tell.
    const second = await sendAnnouncement({ classId: class1Id, message });
    const s1Rows = await announcementNotifications({ body: message, recipientId: s1Id });
    expect(s1Rows).toHaveLength(1);
    expect(s1Rows[0]!.relatedClassId).toBeNull();
    expect(second.status).toBe(200);
    expect((await second.json()).data.alreadyNotified).toBe(1);
    expect(await prisma.announcement.count({ where: { teacherId, message } })).toBe(1);
  });
});

describe('all-students send and an archived link', () => {
  useWorld('archived');

  // Own class and students, isolated from the outer fixtures: an
  // all-students send fans out across every class this teacher owns, so a
  // student registered here would otherwise inflate `recipientCount` in
  // every other test in this file.
  let archivedLinkClassId: string;
  let activeStudentId: string;
  let archivedStudentId: string;
  let crossTeacherArchivedStudentId: string;

  beforeAll(async () => {
    const date = new Date();
    date.setDate(date.getDate() + 28);
    date.setUTCHours(0, 0, 0, 0);
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
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
    });
    archivedLinkClassId = cls.id;

    const active = await prisma.student.create({
      data: {
        firstName: 'Active',
        lastName: 'Student',
        email: `announce-active-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    activeStudentId = active.id;
    const archived = await prisma.student.create({
      data: {
        firstName: 'Archived',
        lastName: 'Student',
        email: `announce-archived-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    archivedStudentId = archived.id;
    const crossTeacherArchived = await prisma.student.create({
      data: {
        firstName: 'CrossArchived',
        lastName: 'Student',
        email: `announce-cross-archived-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    crossTeacherArchivedStudentId = crossTeacherArchived.id;

    await prisma.registration.create({
      data: { classId: archivedLinkClassId, studentId: activeStudentId, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.registration.create({
      data: { classId: archivedLinkClassId, studentId: archivedStudentId, status: 'registered', tierAtBooking: 3 },
    });
    await prisma.registration.create({
      data: { classId: archivedLinkClassId, studentId: crossTeacherArchivedStudentId, status: 'registered', tierAtBooking: 3 },
    });
    // Archiving means no longer this teacher's active student
    // (docs/data-model.md, TeacherStudent).
    await prisma.teacherStudent.create({
      data: { teacherId, studentId: archivedStudentId, isArchived: true },
    });
    // Realistic shape: registering normally links the student to THIS
    // teacher too, and that link is active.
    await prisma.teacherStudent.create({
      data: { teacherId, studentId: crossTeacherArchivedStudentId, isArchived: false },
    });
    // Archived with a DIFFERENT teacher. The exclusion in route.ts is
    // scoped to `teacherId: session.teacherId`, so an archived link with
    // someone else must not hide this student from THIS teacher's send.
    await prisma.teacherStudent.create({
      data: { teacherId: otherTeacherId, studentId: crossTeacherArchivedStudentId, isArchived: true },
    });
  });

  afterAll(async () => {
    // The TeacherStudent rows above cascade off either FK
    // (prisma/schema.prisma, TeacherStudent) when the student rows below
    // are deleted — no explicit delete needed.
    const studentIds = [activeStudentId, archivedStudentId, crossTeacherArchivedStudentId].filter(Boolean);
    if (studentIds.length) {
      await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    }
    if (archivedLinkClassId) {
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: archivedLinkClassId } } } });
    }
    if (studentIds.length) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
  });

  it('notifies the active student and skips the archived one', async () => {
    const before = new Date();
    const res = await sendAnnouncement({ message: `Archived skip ${suffix}` });
    expect(res.status).toBe(201);

    const rows = await prisma.notification.findMany({
      where: { type: 'announcement', createdAt: { gt: before } },
    });
    const recipientIds = rows.map((r) => r.recipientId);
    expect(recipientIds).toContain(activeStudentId);
    expect(recipientIds).not.toContain(archivedStudentId);
    // Archived with a different teacher: the exclusion must not reach
    // across teachers, so this teacher's send still notifies them.
    expect(recipientIds).toContain(crossTeacherArchivedStudentId);
  });
});

describe('an erased student (#48)', () => {
  useWorld('erased');

  // Own class and students, for the same reason as the archived-link block
  // above. The erased profile keeps a `registered` row, standing in for the
  // started or completed class whose registration erasure leaves uncancelled.
  let erasedClassId: string;
  let liveStudentId: string;
  let erasedStudentId: string;

  beforeAll(async () => {
    const date = new Date();
    date.setDate(date.getDate() + 35);
    date.setUTCHours(0, 0, 0, 0);
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
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
    });
    erasedClassId = cls.id;
    const live = await prisma.student.create({
      data: {
        firstName: 'Present',
        lastName: 'Student',
        email: `announce-present-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    liveStudentId = live.id;
    const erased = await prisma.student.create({
      data: {
        firstName: 'Deleted',
        lastName: 'Student',
        email: `announce-erased-${suffix}@test.local`,
        incomeTier: 3,
        deletedAt: new Date(),
      },
    });
    erasedStudentId = erased.id;
    for (const studentId of [liveStudentId, erasedStudentId]) {
      await prisma.registration.create({
        data: { classId: erasedClassId, studentId, status: 'registered', tierAtBooking: 3 },
      });
    }
  });

  afterAll(async () => {
    const studentIds = [liveStudentId, erasedStudentId].filter(Boolean);
    if (studentIds.length) {
      await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    }
    if (erasedClassId) {
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: erasedClassId } } } });
    }
    if (studentIds.length) {
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
  });

  async function erasedWasTold(message: string): Promise<boolean> {
    const rows = await prisma.notification.count({
      where: { type: 'announcement', recipientId: erasedStudentId, body: message },
    });
    const recorded = await prisma.announcement.count({
      where: { teacherId, message, audienceStudentIds: { has: erasedStudentId } },
    });
    return rows + recorded > 0;
  }

  it('a class-scoped send skips the erased registrant', async () => {
    const message = `Erased class ${suffix}`;
    const res = await sendAnnouncement({ classId: erasedClassId, message });
    expect(res.status).toBe(201);
    expect((await res.json()).data.recipientCount).toBe(1);
    expect(await erasedWasTold(message)).toBe(false);
  });

  it('an all-students send skips the erased student', async () => {
    const message = `Erased all ${suffix}`;
    const res = await sendAnnouncement({ message });
    expect(res.status).toBe(201);
    expect(await erasedWasTold(message)).toBe(false);
  });

  it('a custom list naming the erased student drops them', async () => {
    const message = `Erased custom ${suffix}`;
    const res = await sendAnnouncement({ studentIds: [liveStudentId, erasedStudentId], message });
    expect(res.status).toBe(201);
    expect((await res.json()).data.recipientCount).toBe(1);
    expect(await erasedWasTold(message)).toBe(false);
  });

  it('is absent from the audience picker', async () => {
    const res = await fetch(`${BASE_URL}/api/announcements/audience`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.students.map((s: { id: string }) => s.id);
    expect(ids).toContain(liveStudentId);
    expect(ids).not.toContain(erasedStudentId);
  });
});

describe('POST /api/announcements: custom audience, selection (#48)', () => {
  useWorld('custom-a');

  it('notifies exactly the selected, eligible, unmuted students', async () => {
    const res = await sendAnnouncement({ studentIds: [s1Id, s4Id], message: 'Custom A' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(2);
    // The stored audience is read from the row, never handed back.
    expect(data).not.toHaveProperty('audienceStudentIds');
    const stored = await prisma.announcement.findUniqueOrThrow({ where: { id: data.id } });
    expect(stored.audienceStudentIds).toEqual([s1Id, s4Id].sort());
    const rows = await announcementNotifications({ body: 'Custom A' });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([s1Id, s4Id].sort());
    expect(rows[0]!.relatedClassId).toBeNull();
  });

  it("never notifies another teacher's student, and answers as if the id were absent", async () => {
    const res = await sendAnnouncement({ studentIds: [s1Id, foreignStudentId], message: 'Custom B' });
    expect(res.status).toBe(201);
    expect((await res.json()).data.recipientCount).toBe(1);
    const foreign = await prisma.notification.findMany({
      where: { recipientId: foreignStudentId, body: 'Custom B' },
    });
    expect(foreign).toHaveLength(0);
  });

  it('answers a foreign id and an unknown id identically', async () => {
    const unknown = '00000000-0000-4000-8000-00000000dead';
    const a = await sendAnnouncement({ studentIds: [foreignStudentId], message: 'Custom C' });
    const b = await sendAnnouncement({ studentIds: [unknown], message: 'Custom C' });
    expect(a.status).toBe(400);
    expect(b.status).toBe(400);
    expect(await a.json()).toEqual(await b.json());
  });

  it('drops muted and cancelled-only students, 400 when nothing remains', async () => {
    const res = await sendAnnouncement({ studentIds: [s2Id, s3Id], message: 'Custom D' });
    expect(res.status).toBe(400);
    // Both empty-audience refusals are 400 with no code, so the sentence is
    // the only thing that says which audience was empty.
    expect((await res.json()).error.message).toBe(NO_RECIPIENTS_MESSAGE.chosen);
    expect(await prisma.announcement.count({ where: { teacherId, message: 'Custom D' } })).toBe(0);
  });

  it('drops an archived student', async () => {
    await prisma.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId, studentId: s4Id } },
      create: { teacherId, studentId: s4Id, isArchived: true },
      update: { isArchived: true },
    });
    try {
      const res = await sendAnnouncement({ studentIds: [s1Id, s4Id], message: 'Custom E' });
      expect((await res.json()).data.recipientCount).toBe(1);
    } finally {
      await prisma.teacherStudent.deleteMany({ where: { teacherId, studentId: s4Id } });
    }
  });

  it('refuses a class and a list together', async () => {
    const res = await sendAnnouncement({ classId: class1Id, studentIds: [s1Id], message: 'Custom F' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/announcements: custom audience, growth and dedupe (#48)', () => {
  useWorld('custom-b');

  it('tells only the additions when the list grows inside the window', async () => {
    await sendAnnouncement({ studentIds: [s1Id], message: 'Custom G' });
    const res = await sendAnnouncement({ studentIds: [s1Id, s4Id], message: 'Custom G' });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1);
    expect(data.alreadyNotified).toBe(1);
    const rows = await announcementNotifications({ body: 'Custom G' });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([s1Id, s4Id].sort());
  });

  it('collapses duplicate ids in the list to one notification', async () => {
    const res = await sendAnnouncement({ studentIds: [s1Id, s1Id], message: 'Custom H' });
    expect(await announcementNotifications({ body: 'Custom H' })).toHaveLength(1);
    const { data } = await res.json();
    expect(data.recipientCount).toBe(1);
    const stored = await prisma.announcement.findUniqueOrThrow({ where: { id: data.id } });
    expect(stored.audienceStudentIds).toEqual([s1Id]);
  });

  it('stores the audience sorted, whatever order the list came in', async () => {
    const descending = [s1Id, s4Id].sort().reverse();
    const res = await sendAnnouncement({ studentIds: descending, message: 'Custom H2' });
    const { data } = await res.json();
    const stored = await prisma.announcement.findUniqueOrThrow({ where: { id: data.id } });
    expect(stored.audienceStudentIds).toEqual([...descending].reverse());
  });

  it('drops a contact who is linked but never booked, 400 when nothing remains', async () => {
    const res = await sendAnnouncement({ studentIds: [linkedOnlyId], message: 'Custom J' });
    expect(res.status).toBe(400);
    expect(await prisma.announcement.count({ where: { teacherId, message: 'Custom J' } })).toBe(0);
  });

  it('drops a cancelled-only student and tells the rest', async () => {
    const res = await sendAnnouncement({ studentIds: [s1Id, s3Id], message: 'Custom K' });
    expect(res.status).toBe(201);
    expect((await res.json()).data.recipientCount).toBe(1);
    const rows = await announcementNotifications({ body: 'Custom K' });
    expect(rows.map((r) => r.recipientId)).toEqual([s1Id]);
    expect(await prisma.notification.count({ where: { recipientId: s3Id, body: 'Custom K' } })).toBe(0);
  });

  it('a suppressed answer counts the requested students already told, not the latest row', async () => {
    await sendAnnouncement({ studentIds: [s1Id, s4Id], message: 'Custom I' });
    const res = await sendAnnouncement({ studentIds: [s1Id], message: 'Custom I' });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The goal — every requested student has the message — already holds.
    expect(body.outcome).toBe('unchanged');
    const { data } = body;
    expect(data.duplicateSuppressed).toBe(true);
    expect(data.alreadyNotified).toBe(1);
    expect(data.recipientCount).toBe(1); // the latest row's own count is 2
    // Only what is true of this request: nothing of the stored row leaks.
    expect(Object.keys(data).sort()).toEqual(['alreadyNotified', 'duplicateSuppressed', 'recipientCount']);
  });
});

describe('GET /api/announcements/audience (#48)', () => {
  useWorld('audience');

  async function getAudience() {
    return fetch(`${BASE_URL}/api/announcements/audience`, { headers: cookie(teacherToken) });
  }

  it('lists the audience including muted students, excluding cancelled-only and foreign ones', async () => {
    const res = await getAudience();
    expect(res.status).toBe(200);
    const ids = (await res.json()).data.students.map((s: { id: string }) => s.id);
    expect(ids).toEqual(expect.arrayContaining([s1Id, s2Id, s4Id]));
    expect(ids).not.toContain(s3Id);
    expect(ids).not.toContain(foreignStudentId);
    expect(ids).not.toContain(linkedOnlyId);
  });

  it('answers each student as exactly an id and a name', async () => {
    const students = (await (await getAudience()).json()).data.students as Record<string, unknown>[];
    expect(students.length).toBeGreaterThan(0);
    for (const s of students) expect(Object.keys(s).sort()).toEqual(['displayName', 'id']);
  });

  describe('order', () => {
    // Inserted in the reverse of their name order, so an answer in
    // insertion order fails.
    let zedId: string;
    let abeId: string;

    beforeAll(async () => {
      for (const name of ['Zed', 'Abe']) {
        const s = await prisma.student.create({
          data: {
            firstName: name,
            lastName: 'Order',
            email: `announce-order-${name.toLowerCase()}-${suffix}@test.local`,
            incomeTier: 3,
          },
        });
        await prisma.registration.create({
          data: { classId: class2Id, studentId: s.id, status: 'registered', tierAtBooking: 3 },
        });
        if (name === 'Zed') zedId = s.id;
        else abeId = s.id;
      }
    });

    afterAll(async () => {
      const ids = [zedId, abeId].filter(Boolean);
      if (ids.length) await prisma.student.deleteMany({ where: { id: { in: ids } } });
    });

    it('sorts by the name shown', async () => {
      const students = (await (await getAudience()).json()).data.students as {
        id: string;
        displayName: string;
      }[];
      const names = students.map((s) => s.displayName);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      const ids = students.map((s) => s.id);
      expect(ids.indexOf(abeId)).toBeLessThan(ids.indexOf(zedId));
    });
  });

  it('shows first name plus initial unless the student shares their full name', async () => {
    const res = await getAudience();
    const s1 = (await res.json()).data.students.find((s: { id: string }) => s.id === s1Id);
    expect(s1.displayName).toBe('Dedup s.'); // surname withheld by default

    await prisma.studentPrivacy.create({
      data: { studentId: s4Id, teacherId, shareFullName: true },
    });
    const shared = (await (await getAudience()).json()).data.students.find(
      (s: { id: string }) => s.id === s4Id,
    );
    expect(shared.displayName).toBe('Second Student');
  });

  it('401 without a session', async () => {
    const res = await fetch(`${BASE_URL}/api/announcements/audience`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/announcements: the hourly send limit (#769)', () => {
  useWorld('throttle');

  it('refuses the send after ten in an hour, and leaves another teacher unaffected', async () => {
    for (let i = 1; i <= 10; i++) {
      const res = await sendAnnouncement({ message: `Within the limit ${i} ${suffix}` });
      expect(res.status).toBe(201);
    }

    const before = await prisma.announcement.count({ where: { teacherId } });
    const refused = await sendAnnouncement({ message: `Over the limit ${suffix}` });
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.message).toMatch(
      /^Too many announcements\. Try again in \d+ minutes?\.$/,
    );
    // The refusal costs no write.
    expect(await prisma.announcement.count({ where: { teacherId } })).toBe(before);

    // The budget is per teacher: the other teacher of this world, who owns a
    // class with a registrant of their own, still sends.
    const otherToken = await seedSession(prisma, otherTeacherAccountId);
    const other = await fetch(`${BASE_URL}/api/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(otherToken) },
      body: JSON.stringify({ message: `Another teacher ${suffix}` }),
    });
    expect(other.status).toBe(201);
  }, 60_000);
});

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { log } from '@/lib/log';
import { sendAnnouncement, ANNOUNCEMENT_DEDUPE_WINDOW_MS } from './announcements';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import type { CreateNotificationInput } from './notifications';

const prisma = new PrismaClient();
const suffix = `announce-svc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function to(
  studentIds: string[],
  message: string,
  classId: string | null,
): CreateNotificationInput[] {
  return studentIds.map((recipientId) => ({
    recipientType: 'student',
    recipientId,
    type: 'announcement',
    title: 'New announcement',
    body: message,
    ...(classId ? { relatedClassId: classId } : {}),
  }));
}

describe('Announcement Service', () => {
  let teacherId: string;
  let otherTeacherId: string;
  let class1Id: string;
  let student1Id: string;
  let student2Id: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'AnnounceSvc',
        lastName: 'Teacher',
        email: `announce-svc-${suffix}@test.local`,
        account: { create: { email: `announce-svc-${suffix}@test.local` } },
        bio: 'Service test teacher',
        pageSlug: `announce-svc-${suffix}`,
      },
    });
    teacherId = teacher.id;

    const otherTeacher = await prisma.teacher.create({
      data: {
        firstName: 'OtherSvc',
        lastName: 'Teacher',
        email: `other-svc-${suffix}@test.local`,
        account: { create: { email: `other-svc-${suffix}@test.local` } },
        bio: 'Other test teacher',
        pageSlug: `other-svc-${suffix}`,
      },
    });
    otherTeacherId = otherTeacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Svc Studio',
        address: `${suffix} Street`,
        city: 'Amsterdam',
        postcode: '1000AA',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    const date = new Date();
    date.setDate(date.getDate() + 7);
    date.setUTCHours(0, 0, 0, 0);

    const cls1 = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Vinyasa',
      date,
      startTime: hhmmToTime('10:00'),
      durationMinutes: 60,
      roomCost: 30,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 10,
      status: 'open',
    });
    class1Id = cls1.id;

    const s1 = await prisma.student.create({
      data: {
        firstName: 'Student1',
        lastName: 'Test',
        email: `s1-${suffix}@test.local`,
        incomeTier: 2,
      },
    });
    student1Id = s1.id;

    const s2 = await prisma.student.create({
      data: {
        firstName: 'Student2',
        lastName: 'Test',
        email: `s2-${suffix}@test.local`,
        incomeTier: 2,
      },
    });
    student2Id = s2.id;
  });

  afterAll(async () => {
    const studentIds = [student1Id, student2Id].filter(Boolean);
    if (studentIds.length) {
      await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
    }
    if (teacherId) await prisma.announcement.deleteMany({ where: { teacherId } });
    if (otherTeacherId) await prisma.announcement.deleteMany({ where: { teacherId: otherTeacherId } });
    await prisma.$disconnect();
  });

  it('exports the 2-minute dedupe window constant', () => {
    expect(ANNOUNCEMENT_DEDUPE_WINDOW_MS).toBe(2 * 60 * 1000);
  });

  it('creates an Announcement record and fans out notifications on first send', async () => {
    const message = `Welcome to class ${suffix}`;
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
        relatedClassId: class1Id,
      },
      {
        recipientType: 'student',
        recipientId: student2Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
        relatedClassId: class1Id,
      },
    ];

    const result = await sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message,
      recipients,
    });

    expect(result.deduped).toBe(false);
    expect(result.announcement.id).toBeDefined();
    expect(result.announcement.teacherId).toBe(teacherId);
    expect(result.announcement.classId).toBe(class1Id);
    expect(result.announcement.message).toBe(message);
    expect(result.announcement.recipientCount).toBe(2);

    const notifications = await prisma.notification.findMany({
      where: {
        type: 'announcement',
        body: message,
      },
    });
    expect(notifications).toHaveLength(2);
  });

  it('deduplicates an identical send within the window and suppresses extra notifications', async () => {
    const message = `Dedupe test message ${suffix}`;
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
        relatedClassId: class1Id,
      },
    ];

    const first = await sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message,
      recipients,
    });
    expect(first.deduped).toBe(false);

    const second = await sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message,
      recipients,
    });
    expect(second.deduped).toBe(true);
    expect(second.announcement.id).toBe(first.announcement.id);

    // Notifications were fanned out only once
    const notifications = await prisma.notification.findMany({
      where: {
        type: 'announcement',
        body: message,
      },
    });
    expect(notifications).toHaveLength(1);

    // Announcement record was created only once
    const announcements = await prisma.announcement.findMany({
      where: {
        teacherId,
        message,
      },
    });
    expect(announcements).toHaveLength(1);
  });

  it('does not deduplicate when teacherId differs', async () => {
    const message = `Teacher diff test ${suffix}`;
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
      },
    ];

    const first = await sendAnnouncement(prisma, {
      teacherId,
      classId: null,
      message,
      recipients,
    });
    expect(first.deduped).toBe(false);

    const other = await sendAnnouncement(prisma, {
      teacherId: otherTeacherId,
      classId: null,
      message,
      recipients,
    });
    expect(other.deduped).toBe(false);
    expect(other.announcement.id).not.toBe(first.announcement.id);
  });

  it('a superset resend notifies only the students not yet told', async () => {
    const message = `Superset ${suffix}`;
    const first = await sendAnnouncement(prisma, {
      teacherId, classId: null, message, recipients: to([student1Id], message, null),
    });
    expect(first.deduped).toBe(false);

    const second = await sendAnnouncement(prisma, {
      teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null),
    });
    expect(second.deduped).toBe(false);
    expect(second.alreadyNotified).toBe(1);
    expect(second.announcement.recipientCount).toBe(1);
    expect(second.announcement.audienceStudentIds).toEqual([student2Id]);

    const rows = await prisma.notification.findMany({ where: { type: 'announcement', body: message } });
    expect(rows.map((r) => r.recipientId).sort()).toEqual([student1Id, student2Id].sort());
  });

  it('an identical resend tells nobody new and reports deduped', async () => {
    const message = `Identical ${suffix}`;
    await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null) });
    const again = await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student1Id], message, null) });
    expect(again.deduped).toBe(true);
    expect(again.alreadyNotified).toBe(1);
    const rows = await prisma.notification.findMany({ where: { type: 'announcement', body: message } });
    expect(rows).toHaveLength(2);
  });

  it('a class send then an all-students send does not tell the registrants twice', async () => {
    const message = `Class then all ${suffix}`;
    await sendAnnouncement(prisma, { teacherId, classId: class1Id, message, recipients: to([student1Id], message, class1Id) });
    const all = await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null) });
    expect(all.alreadyNotified).toBe(1);
    const rows = await prisma.notification.findMany({ where: { type: 'announcement', body: message, recipientId: student1Id } });
    expect(rows).toHaveLength(1);
  });

  it('counts a student as told by any recent send, not only the latest', async () => {
    const message = `Union ${suffix}`;
    await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student1Id], message, null) });
    await sendAnnouncement(prisma, { teacherId, classId: null, message, recipients: to([student2Id], message, null) });
    const both = await sendAnnouncement(prisma, {
      teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null),
    });
    expect(both.deduped).toBe(true);
    expect(both.alreadyNotified).toBe(2);
    for (const studentId of [student1Id, student2Id]) {
      const rows = await prisma.notification.findMany({
        where: { type: 'announcement', body: message, recipientId: studentId },
      });
      expect(rows).toHaveLength(1);
    }
  });

  it('lists one student once when recipients repeats them', async () => {
    const message = `Repeated ${suffix}`;
    const r = await sendAnnouncement(prisma, {
      teacherId, classId: null, message, recipients: to([student1Id, student1Id], message, null),
    });
    expect(r.announcement.recipientCount).toBe(1);
    expect(r.announcement.audienceStudentIds).toEqual([student1Id]);
  });

  it('logs how many students a send was asked to tell and how many it told', async () => {
    const message = `Outcome log ${suffix}`;
    const info = vi.spyOn(log, 'info').mockImplementation(() => log);
    try {
      await sendAnnouncement(prisma, {
        teacherId, classId: null, message, recipients: to([student1Id, student1Id], message, null),
      });
      expect(info).toHaveBeenLastCalledWith(
        expect.objectContaining({ requested: 1, created: 1, deduped: false }),
        'announcement sent',
      );

      await sendAnnouncement(prisma, {
        teacherId, classId: null, message, recipients: to([student1Id, student2Id], message, null),
      });
      expect(info).toHaveBeenLastCalledWith(
        expect.objectContaining({ requested: 2, created: 1, alreadyNotified: 1 }),
        'announcement sent',
      );

      await sendAnnouncement(prisma, {
        teacherId, classId: null, message, recipients: to([student2Id], message, null),
      });
      expect(info).toHaveBeenLastCalledWith(
        expect.objectContaining({ requested: 1, created: 0, deduped: true }),
        'announcement send suppressed as duplicate',
      );
    } finally {
      info.mockRestore();
    }
  });

  it('deduplicates a second identical all-students send (both classId null)', async () => {
    const message = `All-students dedupe test ${suffix}`;
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
      },
    ];

    const first = await sendAnnouncement(prisma, {
      teacherId,
      classId: null,
      message,
      recipients,
    });
    expect(first.deduped).toBe(false);

    const second = await sendAnnouncement(prisma, {
      teacherId,
      classId: null,
      message,
      recipients,
    });
    expect(second.deduped).toBe(true);
    expect(second.announcement.id).toBe(first.announcement.id);

    const notifications = await prisma.notification.findMany({
      where: { type: 'announcement', body: message },
    });
    expect(notifications).toHaveLength(1);
  });

  it('does not deduplicate when message differs', async () => {
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: `Message A ${suffix}`,
        relatedClassId: class1Id,
      },
    ];

    const first = await sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message: `Message A ${suffix}`,
      recipients,
    });
    expect(first.deduped).toBe(false);

    const second = await sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message: `Message B ${suffix}`,
      recipients,
    });
    expect(second.deduped).toBe(false);
    expect(second.announcement.id).not.toBe(first.announcement.id);
  });

  it('sends a genuinely later identical announcement once window has elapsed', async () => {
    const message = `Expiry test message ${suffix}`;
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
        relatedClassId: class1Id,
      },
    ];

    const first = await sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message,
      recipients,
    });
    expect(first.deduped).toBe(false);

    // Backdate the first announcement beyond the dedupe window
    await prisma.announcement.update({
      where: { id: first.announcement.id },
      data: { sentAt: new Date(Date.now() - ANNOUNCEMENT_DEDUPE_WINDOW_MS - 1000) },
    });

    const second = await sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message,
      recipients,
    });
    expect(second.deduped).toBe(false);
    expect(second.announcement.id).not.toBe(first.announcement.id);
  });

  it('makes sendAnnouncement wait when another transaction holds the advisory lock for the same slot', async () => {
    const other = new PrismaClient();
    const message = `Advisory wait test ${suffix}`;
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
        relatedClassId: class1Id,
      },
    ];

    // Compute the exact 32-bit hash for the slot tuple
    const key = `${teacherId}|${message}`;
    const hash = crypto.createHash('sha256').update(key).digest().readInt32BE(0);

    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const parked = new Promise<void>((r) => {
      locked = r;
    });

    const order: string[] = [];

    // Holder transaction acquires the advisory lock under namespace 196
    const holding = other.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM (
            SELECT pg_advisory_xact_lock(196::int4, ${hash}::int4)
          ) AS taken`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await parked;

    // sendAnnouncement should take the same advisory lock and therefore park
    const sending = sendAnnouncement(prisma, {
      teacherId,
      classId: class1Id,
      message,
      recipients,
    }).then(() => {
      order.push('sending resolved');
    });

    // Wait to verify sending is parked behind the advisory lock
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual([]);

    order.push('first released');
    release();
    await holding;
    await sending;
    await other.$disconnect();

    expect(order).toEqual(['first released', 'sending resolved']);
  });

  it('parks a send on the same teacher and message in any scope, and only on that (lock-key composition)', async () => {
    const message = `Key neighbour test ${suffix}`;
    // The holder is a real class-scoped send: it takes the advisory lock the
    // implementation computes, then parks on its Notification insert while a
    // second connection holds the Class row FOR UPDATE. The key is never
    // recomputed here, so a key that drops or adds a column changes which of
    // the sends below park. The neighbours carry no relatedClassId, so none of
    // them needs the Class row and only the advisory lock can park them.
    const holderClient = new PrismaClient();
    const classHolder = new PrismaClient();
    const parkedClient = new PrismaClient();

    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    const classLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holdingClass = classHolder.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${class1Id} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await classLocked;

    const holderSend = sendAnnouncement(holderClient, {
      teacherId,
      classId: class1Id,
      message,
      recipients: to([student1Id], message, class1Id),
    });
    await new Promise((r) => setTimeout(r, 300));

    const outcome = (p: Promise<unknown>, ms: number) =>
      Promise.race([
        p.then(() => 'sent' as const),
        new Promise<'parked'>((resolve) => setTimeout(() => resolve('parked'), ms)),
      ]);

    // Same (teacher, message), different scope: shares the holder's key.
    const sameSlot = sendAnnouncement(parkedClient, {
      teacherId,
      classId: null,
      message,
      recipients: to([student2Id], message, null),
    });

    try {
      expect(
        await outcome(
          sendAnnouncement(prisma, {
            teacherId: otherTeacherId,
            classId: null,
            message,
            recipients: to([student2Id], message, null),
          }),
          1500,
        ),
      ).toBe('sent');
      expect(
        await outcome(
          sendAnnouncement(prisma, {
            teacherId,
            classId: null,
            message: `${message} two`,
            recipients: to([student2Id], `${message} two`, null),
          }),
          1500,
        ),
      ).toBe('sent');

      let sameSlotSettled = false;
      void sameSlot.then(() => {
        sameSlotSettled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(sameSlotSettled).toBe(false);
    } finally {
      release();
      await holdingClass;
    }
    await Promise.all([holderSend, sameSlot]);
    await holderClient.$disconnect();
    await classHolder.$disconnect();
    await parkedClient.$disconnect();
  });

  it('serialises concurrent sends with the same slot so only one creates and the other dedupes', async () => {
    const message = `Concurrent lever test message ${suffix}`;
    const recipients: CreateNotificationInput[] = [
      {
        recipientType: 'student',
        recipientId: student1Id,
        type: 'announcement',
        title: 'New announcement',
        body: message,
        relatedClassId: class1Id,
      },
    ];

    // Deterministic lever: holding the Class row FOR UPDATE forces the first
    // send to park on its Notification insert (which takes FOR KEY SHARE on Class).
    // The second send must then park on the advisory lock before its own findMany.
    // Without the advisory lock, the second send passes findMany, sees no committed
    // announcement, and also attempts to insert, creating duplicates.
    const holder = new PrismaClient();
    const clientA = new PrismaClient();
    const clientB = new PrismaClient();

    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
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
      sendAnnouncement(clientA, {
        teacherId,
        classId: class1Id,
        message,
        recipients,
      }),
      sendAnnouncement(clientB, {
        teacherId,
        classId: class1Id,
        message,
        recipients,
      }),
    ]);

    let settled = false;
    void both.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 600));

    // Both calls should be in-flight (one parked on Class row, one parked on advisory lock)
    expect(settled).toBe(false);

    release();
    await holding;
    const [r1, r2] = await both;

    await holder.$disconnect();
    await clientA.$disconnect();
    await clientB.$disconnect();

    const createdCount = [r1, r2].filter((r) => !r.deduped).length;
    const dedupedCount = [r1, r2].filter((r) => r.deduped).length;

    expect(createdCount).toBe(1);
    expect(dedupedCount).toBe(1);

    const notifications = await prisma.notification.findMany({
      where: {
        type: 'announcement',
        body: message,
      },
    });
    expect(notifications).toHaveLength(1);

    const announcements = await prisma.announcement.findMany({
      where: {
        teacherId,
        message,
      },
    });
    expect(announcements).toHaveLength(1);
  });
});

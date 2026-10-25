import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import type { NotificationType, RegistrationStatus } from '@/lib/prisma-client';
import { createPrismaClient } from '@/lib/prisma-client';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';
import { VIDEO_LINK_EMAIL_TYPES } from '@/lib/notification-links';
import { videoLinkForEmail } from './video-link-for-email';

const prisma = createPrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const LINK = `https://example.invalid/online-911-${suffix}`;

describe('VIDEO_LINK_EMAIL_TYPES', () => {
  it('classifies the booking, promotion, walk-in and reminder types as link-bearing, and no waitlist broadcast', () => {
    for (const type of ['booking_confirmed', 'waitlist_promoted', 'walk_in_added', 'class_reminder'] as const) {
      expect(VIDEO_LINK_EMAIL_TYPES.has(type)).toBe(true);
    }
    for (const type of ['spot_available', 'spot_taken', 'announcement', 'payment_request'] as const) {
      expect(VIDEO_LINK_EMAIL_TYPES.has(type)).toBe(false);
    }
  });
});

describe('videoLinkForEmail (DB)', () => {
  let teacherId = '';
  let accountId = '';
  let roomId = '';
  const studentIds: string[] = [];
  let onlineClassId = '';
  let completedClassId = '';
  let inPersonClassId = '';
  let n = 0;
  let day = 0;

  async function student(): Promise<string> {
    const s = await prisma.student.create({
      data: { firstName: 'Vid', lastName: 'Student', email: `vlink-${suffix}-${n++}@test.local` },
    });
    studentIds.push(s.id);
    return s.id;
  }

  async function registered(classId: string, status: RegistrationStatus = 'registered'): Promise<string> {
    const id = await student();
    await prisma.registration.create({ data: { classId, studentId: id, status, tierAtBooking: 3 } });
    return id;
  }

  async function onlineClass(status: 'open' | 'completed'): Promise<string> {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: null,
      format: 'online',
      videoUrl: LINK,
      classType: 'Online Flow',
      // A day per class: `CalendarEntry_teacher_slot_excl` holds one teacher to one entry per slot.
      date: new Date(Date.UTC(2099, 5, 1 + day++)),
      startTime: hhmmToTime('18:00'),
      durationMinutes: 60,
      roomCost: 0,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 12,
      status,
      ...(status === 'completed' ? { effectiveTeacherRate: 15, totalStudents: 1, totalRevenue: 15, vatTotal: 0 } : {}),
    });
    return cls.id;
  }

  const ask = (recipientId: string, type: NotificationType, relatedClassId: string | null, recipientType = 'student') =>
    videoLinkForEmail(prisma, { recipientType, recipientId, type, relatedClassId });

  beforeAll(async () => {
    const email = `vlink-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Vid',
        lastName: 'Teacher',
        email,
        bio: 'videoLinkForEmail',
        pageSlug: `vlink-teacher-${suffix}`,
        defaultTimezone: 'UTC',
        account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId ?? '';
    const room = await prisma.room.create({
      data: {
        venueName: 'VLink Studio',
        address: `${suffix} VLink St`,
        city: 'Amsterdam',
        postcode: '1000VL',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 20 },
    });

    onlineClassId = await onlineClass('open');
    completedClassId = await onlineClass('completed');
    inPersonClassId = (
      await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Room Flow',
        date: new Date(Date.UTC(2099, 4, 1)),
        startTime: hhmmToTime('18:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 12,
        status: 'open',
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.registration.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('gives a registered student the link', async () => {
    const id = await registered(onlineClassId);
    expect(await ask(id, 'booking_confirmed', onlineClassId)).toBe(LINK);
  });

  it('gives a waitlisted student nothing, even for a link-bearing type', async () => {
    const id = await student();
    await prisma.waitlistEntry.create({ data: { classId: onlineClassId, studentId: id, position: 1 } });
    expect(await ask(id, 'booking_confirmed', onlineClassId)).toBeNull();
  });

  it('gives a student whose registration is cancelled nothing', async () => {
    const id = await registered(onlineClassId, 'cancelled');
    expect(await ask(id, 'booking_confirmed', onlineClassId)).toBeNull();
  });

  it('gives a late-cancelled student nothing: the seat is freed', async () => {
    const id = await registered(onlineClassId, 'late_cancel');
    expect(await ask(id, 'class_reminder', onlineClassId)).toBeNull();
  });

  it('gives a teacher recipient nothing', async () => {
    expect(await ask(teacherId, 'booking_confirmed', onlineClassId, 'teacher')).toBeNull();
  });

  it('gives nothing for a type that is not link-bearing', async () => {
    const id = await registered(onlineClassId);
    expect(await ask(id, 'spot_available', onlineClassId)).toBeNull();
  });

  it('gives nothing for a notification with no class', async () => {
    const id = await registered(onlineClassId);
    expect(await ask(id, 'booking_confirmed', null)).toBeNull();
  });

  it('gives nothing once the class is completed', async () => {
    const id = await registered(completedClassId, 'attended');
    expect(await ask(id, 'booking_confirmed', completedClassId)).toBeNull();
  });

  it('gives nothing once the class is cancelled', async () => {
    const cls = await onlineClass('open');
    const id = await registered(cls);
    await prisma.calendarEntry.updateMany({ where: { classes: { some: { id: cls } } }, data: { cancelledAt: new Date() } });
    expect(await ask(id, 'booking_confirmed', cls)).toBeNull();
  });

  it('gives nothing for an in-person class', async () => {
    const id = await registered(inPersonClassId);
    expect(await ask(id, 'booking_confirmed', inPersonClassId)).toBeNull();
  });

  it('gives nothing for an online class with no link yet', async () => {
    const cls = await onlineClass('open');
    await prisma.class.update({ where: { id: cls }, data: { videoUrl: null } });
    const id = await registered(cls);
    expect(await ask(id, 'booking_confirmed', cls)).toBeNull();
  });

  it('gives the current link, not the one the class had when the notification was written', async () => {
    const cls = await onlineClass('open');
    const id = await registered(cls);
    const replaced = `${LINK}-replaced`;
    await prisma.class.update({ where: { id: cls }, data: { videoUrl: replaced } });
    expect(await ask(id, 'waitlist_promoted', cls)).toBe(replaced);
  });
});

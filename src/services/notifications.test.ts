import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  createNotification,
  createBulkNotifications,
  markAsRead,
  getUnreadForEmailFallback,
  markEmailSent,
} from './notifications';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

// ===========================================================================
// createNotification
// ===========================================================================

describe('createNotification', () => {
  let teacherId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Notify',
        lastName: 'Teacher',
        email: `notify-teacher-${uniqueSuffix}@test.local`,
        bio: 'Test teacher for notification tests',
        pageSlug: `notify-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: teacherId },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
  });

  it('creates a notification with correct defaults', async () => {
    const notification = await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'booking_confirmed',
      title: 'New booking',
      body: 'A student booked your Hatha class.',
    });

    expect(notification.id).toBeDefined();
    expect(notification.recipientType).toBe('teacher');
    expect(notification.recipientId).toBe(teacherId);
    expect(notification.type).toBe('booking_confirmed');
    expect(notification.title).toBe('New booking');
    expect(notification.body).toBe('A student booked your Hatha class.');
    expect(notification.isRead).toBe(false);
    expect(notification.emailSent).toBe(false);
    expect(notification.relatedClassId).toBeNull();
    expect(notification.createdAt).toBeInstanceOf(Date);
  });

  it('creates a notification with relatedClassId when provided', async () => {
    // Create supporting entities for a class
    const room = await prisma.room.create({
      data: {
        venueName: 'Notify Studio',
        address: `${uniqueSuffix} Notify St`,
        city: 'Amsterdam',
        postcode: '1234NT',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });

    const teacherRoom = await prisma.teacherRoom.create({
      data: {
        teacherId,
        roomId: room.id,
        capacityOverride: 15,
        rentalRate: 35,
      },
    });

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Hatha',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
      },
    });

    const notification = await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'class_cancelled',
      title: 'Class cancelled',
      body: 'Your Hatha class was auto-cancelled.',
      relatedClassId: cls.id,
    });

    expect(notification.relatedClassId).toBe(cls.id);

    // Clean up class-related data
    await prisma.notification.delete({ where: { id: notification.id } });
    await prisma.class.delete({ where: { id: cls.id } });
    await prisma.teacherRoom.delete({ where: { id: teacherRoom.id } });
    await prisma.room.delete({ where: { id: room.id } });
  });

  it('creates a notification with relatedClassId null when not provided', async () => {
    const notification = await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'payment_received',
      title: 'Payment received',
      body: 'A student paid for their class.',
    });

    expect(notification.relatedClassId).toBeNull();
  });
});

// ===========================================================================
// createBulkNotifications
// ===========================================================================

describe('createBulkNotifications', () => {
  let teacherId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'BulkNotify',
        lastName: 'Teacher',
        email: `bulk-notify-teacher-${uniqueSuffix}@test.local`,
        bio: 'Test teacher for bulk notification tests',
        pageSlug: `bulk-notify-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: teacherId },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
  });

  it('creates multiple notifications and returns count', async () => {
    const count = await createBulkNotifications(prisma, [
      {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'Booking 1',
        body: 'First booking notification.',
      },
      {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'Booking 2',
        body: 'Second booking notification.',
      },
      {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'reminder',
        title: 'Reminder',
        body: 'Class starting soon.',
      },
    ]);

    expect(count).toBe(3);

    // Verify they actually exist in the DB
    const notifications = await prisma.notification.findMany({
      where: { recipientId: teacherId },
    });
    expect(notifications).toHaveLength(3);
  });
});

// ===========================================================================
// markAsRead
// ===========================================================================

describe('markAsRead', () => {
  let teacherId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'ReadNotify',
        lastName: 'Teacher',
        email: `read-notify-teacher-${uniqueSuffix}@test.local`,
        bio: 'Test teacher for markAsRead tests',
        pageSlug: `read-notify-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: teacherId },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
  });

  it('marks a notification as read', async () => {
    const notification = await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'waitlist_promoted',
      title: 'Spot available',
      body: 'You have been promoted from the waitlist.',
    });

    expect(notification.isRead).toBe(false);

    await markAsRead(prisma, notification.id);

    const updated = await prisma.notification.findUniqueOrThrow({
      where: { id: notification.id },
    });
    expect(updated.isRead).toBe(true);
  });
});

// ===========================================================================
// getUnreadForEmailFallback + markEmailSent
// ===========================================================================

describe('getUnreadForEmailFallback', () => {
  let teacherId: string;
  let oldNotificationId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'EmailFallback',
        lastName: 'Teacher',
        email: `email-fallback-teacher-${uniqueSuffix}@test.local`,
        bio: 'Test teacher for email fallback tests',
        pageSlug: `email-fallback-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    // Create a notification with createdAt 31 minutes ago
    const thirtyOneMinutesAgo = new Date(Date.now() - 31 * 60 * 1000);
    const oldNotification = await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'Old notification',
        body: 'This notification is 31 minutes old.',
        isRead: false,
        emailSent: false,
        createdAt: thirtyOneMinutesAgo,
      },
    });
    oldNotificationId = oldNotification.id;

    // Create a recent notification (just now) — exists in DB for filtering tests
    await createNotification(prisma, {
      recipientType: 'teacher',
      recipientId: teacherId,
      type: 'reminder',
      title: 'Recent notification',
      body: 'This notification is brand new.',
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: teacherId },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('returns only notifications older than the threshold', async () => {
    const unread = await getUnreadForEmailFallback(prisma);

    // Filter to only this test's notifications (other tests may leave data)
    const ours = unread.filter((n) => n.recipientId === teacherId);

    expect(ours).toHaveLength(1);
    expect(ours[0]!.id).toBe(oldNotificationId);
    expect(ours[0]!.title).toBe('Old notification');
  });

  it('does not return read notifications', async () => {
    // Mark the old notification as read
    await markAsRead(prisma, oldNotificationId);

    const unread = await getUnreadForEmailFallback(prisma);
    const ours = unread.filter((n) => n.recipientId === teacherId);

    expect(ours).toHaveLength(0);

    // Reset for next test
    await prisma.notification.update({
      where: { id: oldNotificationId },
      data: { isRead: false },
    });
  });

  it('does not return notifications with emailSent=true', async () => {
    await markEmailSent(prisma, [oldNotificationId]);

    const unread = await getUnreadForEmailFallback(prisma);
    const ours = unread.filter((n) => n.recipientId === teacherId);

    expect(ours).toHaveLength(0);
  });

  it('returns results ordered by createdAt ASC', async () => {
    // Create another old notification (32 minutes ago)
    const thirtyTwoMinutesAgo = new Date(Date.now() - 32 * 60 * 1000);
    const olderNotification = await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'class_cancelled',
        title: 'Older notification',
        body: 'This notification is 32 minutes old.',
        isRead: false,
        emailSent: false,
        createdAt: thirtyTwoMinutesAgo,
      },
    });

    // Reset the first old notification's emailSent flag
    await prisma.notification.update({
      where: { id: oldNotificationId },
      data: { emailSent: false },
    });

    const unread = await getUnreadForEmailFallback(prisma);
    const ours = unread.filter((n) => n.recipientId === teacherId);

    expect(ours).toHaveLength(2);
    // Older one (32 min ago) should come first
    expect(ours[0]!.id).toBe(olderNotification.id);
    expect(ours[1]!.id).toBe(oldNotificationId);

    // Clean up
    await prisma.notification.delete({ where: { id: olderNotification.id } });
  });

  it('respects custom threshold', async () => {
    // Reset emailSent on old notification
    await prisma.notification.update({
      where: { id: oldNotificationId },
      data: { emailSent: false },
    });

    // With threshold of 60 minutes, the 31-minute-old notification should NOT be returned
    const unread = await getUnreadForEmailFallback(prisma, 60);
    const ours = unread.filter((n) => n.recipientId === teacherId);

    expect(ours).toHaveLength(0);

    // With threshold of 15 minutes, it SHOULD be returned
    const unread2 = await getUnreadForEmailFallback(prisma, 15);
    const ours2 = unread2.filter((n) => n.recipientId === teacherId);

    expect(ours2).toHaveLength(1);
    expect(ours2[0]!.id).toBe(oldNotificationId);
  });
});

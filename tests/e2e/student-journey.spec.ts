import { test, expect, type BrowserContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

/**
 * The student's side of a contested class, end to end through the UI:
 * cancel → rebook (row reactivation), full class → waitlist join/leave/
 * rejoin, and auto-promotion when the seat frees.
 */

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const slug = `e2e-sjourney-${uniqueSuffix}`;
const tokens = {
  alice: crypto.randomBytes(32).toString('hex'),
  bram: crypto.randomBytes(32).toString('hex'),
};

let teacherId: string;
let roomId: string;
let classId: string;
let aliceId: string;
let bramId: string;

async function signIn(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([
    { name: 'fair_yoga_session', value: token, url: 'http://localhost:3000' },
  ]);
}

async function bookViaApi(token: string): Promise<number> {
  const res = await fetch('http://localhost:3000/api/registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `fair_yoga_session=${token}` },
    body: JSON.stringify({ classId }),
  });
  return res.status;
}

test.describe('Student journey — cancel, rebook, waitlist', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Contested',
        lastName: 'Teacher',
        email: `e2e-sjourney-teacher-${uniqueSuffix}@test.local`,
        bio: 'One-seat classes for waitlist e2e',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Tiny Studio',
        address: `${uniqueSuffix} Waitlist St`,
        city: 'Amsterdam',
        postcode: '1234WS',
        floor: '1',
        roomName: 'Nook',
        maxCapacity: 5,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 5, rentalRate: 15 },
    });

    // One seat: the second student always lands on the waitlist.
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'One Seat Yin',
        date: new Date('2099-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 1,
        status: 'open',
      },
    });
    classId = cls.id;

    const mkStudent = async (first: string, token: string) => {
      const student = await prisma.student.create({
        data: {
          firstName: first,
          lastName: 'Student',
          email: `e2e-sjourney-${first.toLowerCase()}-${uniqueSuffix}@test.local`,
          incomeTier: 3,
          claimedAt: new Date(),
        },
      });
      await prisma.session.create({
        data: {
          id: hashToken(token),
          userId: student.id,
          userType: 'student',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
      return student.id;
    };
    aliceId = await mkStudent('Alice', tokens.alice);
    bramId = await mkStudent('Bram', tokens.bram);
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { userId: { in: [aliceId, bramId] } } });
    await prisma.student.deleteMany({ where: { id: { in: [aliceId, bramId] } } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('cancelling frees the seat; rebooking reactivates the old row', async ({
    page,
    context,
  }) => {
    expect(await bookViaApi(tokens.alice)).toBe(201);
    const firstRegistration = await prisma.registration.findFirstOrThrow({
      where: { classId, studentId: aliceId },
    });

    await signIn(context, tokens.alice);
    await page.goto('/bookings');
    // .first(): the class name also appears in the unread-updates strip.
    await expect(page.getByText('One Seat Yin').first()).toBeVisible();

    // Cancel: the inline confirm keeps the same button name.
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    // The card is gone (the strip may still mention the class).
    await expect(page.getByRole('heading', { name: 'Upcoming' })).not.toBeVisible({
      timeout: 10_000,
    });

    // Rebook through the public page — must not 409 on the old row.
    await page.goto(`/${slug}/book/${classId}`);
    await page.getByRole('button', { name: /^Book — around/ }).click();
    await expect(page.getByText("You're in")).toBeVisible();

    const rebooked = await prisma.registration.findFirstOrThrow({
      where: { classId, studentId: aliceId },
    });
    expect(rebooked.id).toBe(firstRegistration.id); // same row, reactivated
    expect(rebooked.status).toBe('registered');
  });

  test('a full class offers the waitlist; leaving and rejoining works', async ({
    page,
    context,
  }) => {
    await signIn(context, tokens.bram);

    await page.goto(`/${slug}/book/${classId}`);
    await page.getByRole('button', { name: 'Join the waitlist' }).click();
    await expect(page.getByText("You're on the waitlist")).toBeVisible();

    await page.goto('/bookings');
    await expect(page.getByRole('heading', { name: 'Waitlist' })).toBeVisible();
    await expect(page.getByText(/position 1/)).toBeVisible();

    // Leave — the section empties.
    await page.getByRole('button', { name: 'Leave waitlist' }).click();
    await expect(page.getByRole('heading', { name: 'Waitlist' })).not.toBeVisible({
      timeout: 10_000,
    });

    // Rejoin — the removed entry reactivates instead of hitting the
    // unique constraint.
    await page.goto(`/${slug}/book/${classId}`);
    await page.getByRole('button', { name: 'Join the waitlist' }).click();
    await expect(page.getByText("You're on the waitlist")).toBeVisible();

    await page.goto('/bookings');
    await expect(page.getByText(/position 1/)).toBeVisible();
  });

  test('a freed seat auto-promotes the waiting student', async ({ page, context }) => {
    // Alice cancels through the UI; Bram is first (and only) in the queue.
    await signIn(context, tokens.alice);
    await page.goto('/bookings');
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await page.getByRole('button', { name: 'Cancel booking' }).click();
    await expect(page.getByRole('heading', { name: 'Upcoming' })).not.toBeVisible({
      timeout: 10_000,
    });

    // Bram now holds the seat: booked, no longer waitlisted.
    await context.clearCookies();
    await signIn(context, tokens.bram);
    await page.goto('/bookings');
    await expect(page.getByRole('heading', { name: 'Upcoming' })).toBeVisible();
    await expect(page.getByText('One Seat Yin').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Waitlist' })).not.toBeVisible();

    const promoted = await prisma.registration.findFirst({
      where: { classId, studentId: bramId, status: 'registered' },
    });
    expect(promoted).not.toBeNull();
  });

  test('the promotion shows as an update on /bookings until marked read', async ({
    page,
    context,
  }) => {
    // The auto-promotion in the previous test created Bram's
    // waitlist_promoted notification — previously invisible in the app.
    await signIn(context, tokens.bram);
    await page.goto('/bookings');

    await expect(page.getByRole('heading', { name: 'Updates' })).toBeVisible();
    await expect(page.getByText('You are in')).toBeVisible();

    await page.getByRole('button', { name: 'Mark read' }).click();
    await expect(page.getByRole('heading', { name: 'Updates' })).not.toBeVisible({
      timeout: 10_000,
    });

    const unread = await prisma.notification.count({
      where: { recipientType: 'student', recipientId: bramId, isRead: false },
    });
    expect(unread).toBe(0);
  });
});

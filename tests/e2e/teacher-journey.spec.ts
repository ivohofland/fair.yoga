import { test, expect, type BrowserContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { accountIdOfTeacher, accountIdOfStudent } from './account-helpers';

/**
 * The core product loop, end to end through the UI:
 * room → class wizard → publish → booking arrives (inbox) → check-in with a
 * walk-in → complete → pricing + payments → mark paid.
 */

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const teacherToken = crypto.randomBytes(32).toString('hex');
const bookingStudentToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let bookingStudentId: string;
let walkInStudentId: string;
let classId: string;

/** A class slot that started five minutes ago, in the teacher's UTC clock. */
function checkinSlot(): { date: Date; startTime: string } {
  const t = new Date(Date.now() - 5 * 60 * 1000);
  const startTime = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const date = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  return { date, startTime };
}

async function signInTeacher(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'fair_yoga_session', value: teacherToken, url: 'http://localhost:3000' },
  ]);
}

test.describe('Teacher journey', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Journey',
        lastName: 'Teacher',
        email: `e2e-journey-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `e2e-journey-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Teacher for the full-journey e2e test',
        pageSlug: `e2e-journey-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    await prisma.session.create({
      data: {
        id: hashToken(teacherToken),
        accountId: await accountIdOfTeacher(prisma, teacherId),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    // This student signs in to book, so they are claimed — and they share
    // their full name with this teacher so the roster reads "Journey
    // Student" rather than the privacy-default initial.
    const bookingStudent = await prisma.student.create({
      data: {
        firstName: 'Journey',
        lastName: 'Student',
        email: `e2e-journey-student-${uniqueSuffix}@test.local`,
        account: { create: { email: `e2e-journey-student-${uniqueSuffix}@test.local` } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    bookingStudentId = bookingStudent.id;
    await prisma.studentPrivacy.create({
      data: { studentId: bookingStudentId, teacherId, shareFullName: true },
    });
    await prisma.session.create({
      data: {
        id: hashToken(bookingStudentToken),
        accountId: await accountIdOfStudent(prisma, bookingStudentId),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    // The walk-in picker is roster-only; this student never signs in and
    // stays a genuinely unclaimed CRM row (full name by default).
    const walkIn = await prisma.student.create({
      data: {
        firstName: 'Walkin',
        lastName: 'Guest',
        email: `e2e-journey-walkin-${uniqueSuffix}@test.local`,
        incomeTier: 2,
      },
    });
    walkInStudentId = walkIn.id;
    await prisma.teacherStudent.create({
      data: { teacherId, studentId: walkInStudentId },
    });
  });

  test.afterAll(async () => {
    await prisma.studentPrivacy.deleteMany({ where: { teacherId } });
    await prisma.notification.deleteMany({
      where: {
        OR: [
          { recipientId: { in: [teacherId, bookingStudentId, walkInStudentId] } },
          ...(classId ? [{ relatedClassId: classId }] : []),
        ],
      },
    });
    if (classId) {
      await prisma.payment.deleteMany({ where: { registration: { classId } } });
      await prisma.registration.deleteMany({ where: { classId } });
    }
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.session.deleteMany({
      where: { accountId: await accountIdOfTeacher(prisma, teacherId) },
    });
    for (const sid of [bookingStudentId, walkInStudentId]) {
      const student = await prisma.student.findUnique({
        where: { id: sid },
        select: { accountId: true },
      });
      if (student?.accountId) {
        await prisma.session.deleteMany({ where: { accountId: student.accountId } });
      }
    }
    await prisma.student.deleteMany({
      where: { id: { in: [bookingStudentId, walkInStudentId] } },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('creates a room through settings', async ({ page, context }) => {
    await signInTeacher(context);
    await page.goto('/settings/rooms/new');

    // Step 1: search by address — nothing exists at this made-up street.
    await page.getByLabel('Postcode').fill('9999JT');
    await page.getByLabel('Street').fill(`Journeyweg-${uniqueSuffix}`);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByText('No rooms found at this address.')).toBeVisible();
    await page.getByRole('button', { name: 'Create new room' }).click();

    // Step 2: the room itself.
    await page.getByLabel('Venue name').fill('Journey Venue');
    await page.getByLabel('City', { exact: true }).fill('Testville');
    await page.getByLabel('Room name').fill('Main Studio');
    await page.getByLabel('Max capacity').fill('12');
    await page.getByRole('button', { name: 'Create room' }).click();

    // Step 3: the teacher's private terms for it.
    await expect(page.getByLabel(/Capacity override/)).toBeVisible();
    await page.getByLabel(/Capacity override/).fill('10');
    await page.getByLabel('Rental rate').fill('20');
    await page.getByRole('button', { name: 'Add room' }).click();

    await page.waitForURL('**/settings/rooms', { timeout: 10_000 });
    await expect(page.getByText('Journey Venue')).toBeVisible();
  });

  test('creates a class with the four-step wizard', async ({ page, context }) => {
    await signInTeacher(context);
    const teacherRoom = await prisma.teacherRoom.findFirstOrThrow({ where: { teacherId } });

    await page.goto('/class/new');
    await expect(page.getByText('Step 1 of 4')).toBeVisible();

    // Basics
    await page.getByLabel('Room').selectOption(teacherRoom.id);
    await page.getByLabel('Class type').fill('Journey Flow');
    await page.getByLabel('Date').fill('2099-06-01');
    await page.getByLabel('Start time').fill('09:00');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Pricing — min 1 student so the auto-cancel sweep never touches it.
    await expect(page.getByText('Step 2 of 4')).toBeVisible();
    await page.getByLabel('Min students').fill('1');
    await page.getByLabel('Max students').fill('8');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Policies (defaults) → Review
    await expect(page.getByText('Step 3 of 4')).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByText('Review your class')).toBeVisible();
    const created = page.waitForResponse(
      (resp) =>
        resp.url().endsWith('/api/classes') && resp.request().method() === 'POST' && resp.ok(),
    );
    await page.getByRole('button', { name: 'Create class' }).click();
    // The id is server truth from the POST; the wizard's client-side push
    // to the class page can be dropped on starved CPUs (see the publish
    // test), so navigate there directly instead of waiting for it.
    const body = (await (await created).json()) as { data: { id: string } };
    classId = body.data.id;
    await page.goto(`/class/${classId}`);

    await expect(page.getByText('Draft')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
  });

  test('publishes the class', async ({ page, context }) => {
    await signInTeacher(context);
    await page.goto(`/class/${classId}`);

    // Wait for the transition POST, then reload and assert the
    // server-rendered truth: on starved CPUs (CI runners) the router can
    // drop the post-action refresh commit — the state change lands, the
    // client repaint doesn't. Same pattern as the walk-in test below.
    const transitioned = page.waitForResponse(
      (resp) => resp.url().includes('/transition') && resp.ok(),
    );
    await page.getByRole('button', { name: 'Publish' }).click();
    await transitioned;
    await page.reload();
    await expect(page.getByText('Open for registration')).toBeVisible({ timeout: 10_000 });
  });

  test('a booking arrives and shows on the class page', async ({ page, context }) => {
    // The student side of this API round-trip is covered in booking.spec.
    const res = await fetch('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fair_yoga_session=${bookingStudentToken}`,
      },
      body: JSON.stringify({ classId }),
    });
    expect(res.status).toBe(201);

    await signInTeacher(context);
    await page.goto(`/class/${classId}`);
    await expect(page.getByRole('heading', { name: 'Registered students' })).toBeVisible();
    await expect(page.getByText('Journey Student')).toBeVisible();
  });

  test('the booking lands in the inbox and can be marked read', async ({ page, context }) => {
    await signInTeacher(context);
    await page.goto('/');

    // Gold dot: the tab announces unread messages.
    await page.getByRole('link', { name: 'Inbox, unread messages' }).click();
    await page.waitForURL('**/inbox');
    // Reload before asserting: the client-side nav commit can be dropped
    // on starved CPUs (see the publish test).
    await page.reload();
    await expect(page.getByText('New booking').first()).toBeVisible();
    await expect(page.getByText('Journey booked Journey Flow.')).toBeVisible();

    // The row flips optimistically BEFORE the POST resolves — wait for the
    // server response, then reload for the tab-bar dot (a reload during the
    // in-flight request would cancel the mark-read).
    const markedRead = page.waitForResponse(
      (resp) => resp.url().includes('/read') && resp.ok(),
    );
    await page.getByRole('button', { name: 'Mark "New booking" read' }).first().click();
    await markedRead;
    await page.reload();
    await expect(page.getByRole('link', { name: 'Inbox', exact: true })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('check-in: a walk-in joins at the door', async ({ page, context }) => {
    // Move the class to "now" — check-in opens 15 minutes before start.
    const slot = checkinSlot();
    await prisma.class.update({
      where: { id: classId },
      data: { date: slot.date, startTime: slot.startTime },
    });

    await signInTeacher(context);
    await page.goto(`/class/${classId}`);
    await expect(page.getByRole('heading', { name: 'Attendance' })).toBeVisible();

    // Add the walk-in from the roster picker.
    await page.getByRole('button', { name: 'Add walk-in' }).click();
    await page.getByLabel('Walk-in student').selectOption(walkInStudentId);
    await page.getByRole('button', { name: 'Add walk-in' }).click();
    // The picker closes on success (the POST is done); a full reload then
    // renders the roster server-side — immune to router.refresh timing on
    // slow CI runners.
    await expect(page.getByLabel('Walk-in student')).toBeHidden({ timeout: 10_000 });
    await page.reload();
    await expect(page.getByText('Walkin Guest')).toBeVisible({ timeout: 10_000 });

    // Tick off the booked student as present.
    await page.getByRole('button', { name: 'Mark Journey Student as present' }).click();
    await expect(
      page.getByRole('button', { name: 'Mark Journey Student as no-show' }),
    ).toBeVisible();
  });

  test('completing runs pricing and payments can be marked paid', async ({ page, context }) => {
    await signInTeacher(context);
    await page.goto(`/class/${classId}`);

    await page.getByRole('button', { name: 'Complete class' }).click();
    await expect(page.getByText('Completed')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Pricing breakdown' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible();

    // Both charged registrations start unpaid; payment state is text, not a badge.
    await expect(page.getByText('○ Unpaid')).toHaveCount(2);
    await page
      .getByRole('button', { name: 'Mark Journey Student payment as paid' })
      .click();
    await expect(page.getByText('✓ Paid')).toBeVisible();
    await expect(page.getByText('○ Unpaid')).toHaveCount(1);

    // A mis-tap is recoverable: transient Undo restores the record.
    await page.getByRole('button', { name: 'Undo marking Journey Student as paid' }).click();
    await expect(page.getByText('○ Unpaid')).toHaveCount(2, { timeout: 10_000 });
    await page
      .getByRole('button', { name: 'Mark Journey Student payment as paid' })
      .click();
    await expect(page.getByText('✓ Paid')).toBeVisible();
  });

  test('an unpaid row sends a reminder the student will hear about', async ({
    page,
    context,
  }) => {
    await signInTeacher(context);
    await page.goto(`/class/${classId}`);

    // The walk-in's payment is the unpaid row; paid rows offer nothing.
    await page.getByRole('button', { name: 'Send reminder to Walkin Guest' }).click();
    await expect(page.getByText(/Reminded just now/)).toBeVisible();

    const reminded = await prisma.payment.findFirst({
      where: { registration: { classId, studentId: walkInStudentId } },
    });
    expect(reminded?.reminderSentAt).not.toBeNull();
    // The walk-in never signs in, so the notification is pinned in the
    // DB; /updates rendering is covered by the updates e2e.
    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: walkInStudentId, type: 'reminder' },
    });
    expect(notification).not.toBeNull();
  });

  test('the payments overview offers the permanent correction', async ({ page, context }) => {
    await signInTeacher(context);
    await page.goto('/settings/payments');

    // The payment marked paid in the previous test sits under Received.
    await expect(page.getByRole('heading', { name: 'Received' })).toBeVisible();
    // The Outstanding row carries the reminder action, and the caption
    // from the class-page send above survives server-side.
    await expect(
      page.getByRole('button', { name: 'Send reminder to Walkin Guest' }),
    ).toBeVisible();
    await expect(page.getByText(/Reminded /)).toBeVisible();
    await page.getByRole('button', { name: 'Mark unpaid' }).click();
    // Wait for the POST, then reload (see the publish test): the row's
    // "Updating..." state clears only via the refresh the router can drop.
    const unpaid = page.waitForResponse(
      (resp) => resp.url().includes('/unpaid') && resp.ok(),
    );
    await page.getByRole('button', { name: 'Confirm unpaid' }).click();
    await unpaid;
    await page.reload();

    // The record moves back to Outstanding; Received empties.
    await expect(page.getByText('Nothing received yet')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Mark unpaid' })).not.toBeVisible();
  });
});

import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher, accountIdOfStudent } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';

/**
 * The core product loop, end to end through the UI:
 * room → class wizard → publish → booking arrives (inbox) → check-in with a
 * walk-in → complete → pricing + payments → mark paid → remind an unpaid row
 * → correct a payment on the overview.
 */

const prisma = new PrismaClient();

const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
let bookingStudentId: string;
let bookingStudentToken: string;
let walkInStudentId: string;
let classId: string;
/** Set by the check-in test, which moves the class to "now"; read by the
 *  payments-overview test to pin the start time inside the reminder label. */
let slot: ReturnType<typeof checkinSlot>;

/** A class slot that started five minutes ago, in the teacher's UTC clock. */
function checkinSlot(): { date: Date; startTime: string } {
  const t = new Date(Date.now() - 5 * 60 * 1000);
  const startTime = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const date = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  return { date, startTime };
}

async function signInTeacher(context: BrowserContext): Promise<void> {
  await context.addCookies([sessionCookie(teacherToken)]);
}

test.describe('Teacher journey', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Journey',
        lastName: 'Teacher',
        email: `e2e-journey-teacher-${suffix}@test.local`,
        account: { create: { email: `e2e-journey-teacher-${suffix}@test.local` } },
        bio: 'Teacher for the full-journey e2e test',
        pageSlug: `e2e-journey-${suffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    teacherToken = await seedSession(prisma, teacherAccountId);

    // This student signs in to book, so they are claimed, and their privacy
    // row shares NOTHING — so wherever this spec renders their name through
    // the projection it must read "Journey s.", never "Journey Student".
    //
    // Be exact about where that is, because an earlier version of this comment
    // said "every teacher-facing surface in this spec", and it is not. All six
    // `Journey s.` assertions are on `/class/[id]` — the roster, the two
    // attendance buttons and the three payment-row buttons. `/inbox` asserts
    // "Journey booked Journey Flow.", a raw first name baked into a
    // notification body at write time, which never passes through
    // `teacherVisibleName`. `/settings/payments` asserts nothing about this
    // student at all; the walk-in below is what covers that page.
    //
    // It was `shareFullName: true` until the PR review of #167, which made
    // those six assertions blind to the gate they look like they exercise: a
    // full name is what `teacherVisibleName` returns whether the gate runs or
    // not, so substituting a raw `${firstName} ${lastName}` at those call
    // sites left the spec green. A truncated name is not a fixed point of that
    // composition, so it can only appear if the projection ran.
    const bookingStudent = await prisma.student.create({
      data: {
        firstName: 'Journey',
        lastName: 'Student',
        email: `e2e-journey-student-${suffix}@test.local`,
        account: { create: { email: `e2e-journey-student-${suffix}@test.local` } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    bookingStudentId = bookingStudent.id;
    await prisma.studentPrivacy.create({
      data: { studentId: bookingStudentId, teacherId, shareFullName: false },
    });
    bookingStudentToken = await seedSession(prisma, await accountIdOfStudent(prisma, bookingStudentId));

    // The walk-in picker is roster-only. This student never drives a browser,
    // but it is claimed and shares nothing — for the same reason the booking
    // student is, and then some.
    //
    // Until #167's round-two review it was a genuinely unclaimed CRM row, and
    // that made two guards inert. `bypassesPrivacy` returned true for it, so
    // the full name rendered whether the projection ran or not: a raw
    // `${firstName} ${lastName}` substituted into `settings/payments/page.tsx`
    // left this spec green — the same defect 4f93343 fixed for the booking
    // student, three lines away, and the reason /settings/payments was the one
    // teacher surface this spec still could not falsify. It also fired the
    // module's `log.warn` on every render that touched the walk-in, so the
    // baseline was dozens of lines a run and the tripwire could not function
    // as an alarm.
    //
    // `Student_claim_link_check` requires claimedAt and accountId to move
    // together, hence the account.
    const walkInEmail = `e2e-journey-walkin-${suffix}@test.local`;
    const walkIn = await prisma.student.create({
      data: {
        firstName: 'Walkin',
        lastName: 'Guest',
        email: walkInEmail,
        account: { create: { email: walkInEmail } },
        claimedAt: new Date(),
        incomeTier: 2,
      },
    });
    walkInStudentId = walkIn.id;
    await prisma.studentPrivacy.create({
      data: { studentId: walkInStudentId, teacherId, shareFullName: false },
    });
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
    // Guarded, because the delete widened at #327. `class.deleteMany({ where:
    // { teacherId } })` used to sit here; the calendar identity moved, so it is
    // the ENTRY that carries `teacherId` and the entry that has to go (the
    // classes ride its cascade). Prisma DROPS an `undefined` where-clause
    // rather than matching nothing, and Playwright runs `afterAll` even when
    // `beforeAll` threw before this id was assigned — so the unguarded form
    // used to empty `Class` and would now empty BOTH families' calendars for
    // every teacher in the database.
    if (teacherId) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    }
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { createdById: teacherId } });
    await prisma.session.deleteMany({
      where: { accountId: await accountIdOfTeacher(prisma, teacherId) },
    });
    const studentAccountIds: string[] = [];
    for (const sid of [bookingStudentId, walkInStudentId]) {
      const student = await prisma.student.findUnique({
        where: { id: sid },
        select: { accountId: true },
      });
      if (student?.accountId) {
        await prisma.session.deleteMany({ where: { accountId: student.accountId } });
        studentAccountIds.push(student.accountId);
      }
    }
    await prisma.student.deleteMany({
      where: { id: { in: [bookingStudentId, walkInStudentId] } },
    });
    // Both students are claimed now, so both own an Account — delete them
    // after the Student rows that point at them.
    await prisma.account.deleteMany({ where: { id: { in: studentAccountIds } } });
    if (teacherId) {
      await prisma.teacher.delete({ where: { id: teacherId } });
    }
    // Issue 177: Account must be deleted after Teacher due to FK reference
    if (teacherAccountId) {
      await prisma.account.deleteMany({ where: { id: teacherAccountId } });
    }
    await prisma.$disconnect();
  });

  test('creates a room through settings', async ({ page, context }) => {
    await signInTeacher(context);
    await page.goto('/settings/rooms/new');

    // Step 1: search by address — nothing exists at this made-up street.
    await page.getByLabel('Postcode').fill('9999JT');
    await page.getByLabel('Street').fill(`Journeyweg-${suffix}`);
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
    await expect(page.getByText('1 Jun 2099 at 09:00 · 60 min')).toBeVisible();
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
    // server-rendered truth: the router can drop a post-action refresh
    // commit, so the state change lands and the client repaint does not.
    // CPU starvation on CI runners was the suspected cause (#40); that
    // remains unverified and its trace artifacts have expired. The reload
    // is correct regardless of which cause drops the commit.
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
    await expect(page.getByText('Journey s.')).toBeVisible();
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
    slot = checkinSlot();
    await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({
        where: { id: classId },
        select: { calendarEntryId: true },
      })).calendarEntryId },
      data: { date: slot.date, startTime: hhmmToTime(slot.startTime) },
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
    await expect(page.getByText('Walkin g.')).toBeVisible({ timeout: 10_000 });

    // Tick off the booked student as present.
    await page.getByRole('button', { name: 'Mark Journey s. as present' }).click();
    await expect(
      page.getByRole('button', { name: 'Mark Journey s. as no-show' }),
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
      .getByRole('button', { name: 'Mark paid — Journey s.' })
      .click();
    await expect(page.getByText('✓ Paid')).toBeVisible();
    await expect(page.getByText('○ Unpaid')).toHaveCount(1);

    // A mis-tap is recoverable: transient Undo restores the record.
    await page.getByRole('button', { name: 'Undo marking Journey s. as paid' }).click();
    await expect(page.getByText('○ Unpaid')).toHaveCount(2, { timeout: 10_000 });
    await page
      .getByRole('button', { name: 'Mark paid — Journey s.' })
      .click();
    await expect(page.getByText('✓ Paid')).toBeVisible();
  });

  test('an unpaid row sends a reminder the student will hear about', async ({
    page,
    context,
  }) => {
    await signInTeacher(context);
    await page.goto(`/class/${classId}`);

    // The walk-in's payment is the unpaid row; the paid row (Journey s.)
    // offers no reminder — you can't dun someone you've marked as paid.
    await expect(
      page.getByRole('button', { name: /Send reminder to Journey s\./ }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Send reminder to Walkin g.' }).click();
    await expect(page.getByText(/Reminded just now/)).toBeVisible();

    const reminded = await prisma.payment.findFirst({
      where: { registration: { classId, studentId: walkInStudentId } },
    });
    expect(reminded?.reminderSentAt).not.toBeNull();
    // The walk-in never signs in, so the notification is pinned in the DB.
    // The /updates row rendering is type-agnostic and pinned in
    // student-journey.spec.ts (promotion/announcement notifications).
    const notification = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: walkInStudentId, type: 'reminder' },
    });
    expect(notification).not.toBeNull();
  });

  test('the payments overview offers the permanent correction', async ({ page, context }) => {
    await signInTeacher(context);
    await page.goto('/settings/payments');

    // The payment marked paid in the previous test sits under Received, whose
    // caption carries the start time for the same reason the Outstanding rows
    // do (#59): two paid classes of one type on one day are otherwise
    // indistinguishable, and the amount does not tell them apart.
    //
    // Pinned here rather than in the component test because this caption is
    // built inline by the page — there is no prop to hand a component test, and
    // nothing else in the suite reads it. It shipped unpinned and a reviewer
    // caught that by deleting the start time and watching every suite pass.
    //
    // Scoped to the Received section on purpose. Both sections show the same
    // class, so an unscoped match is satisfied by the Outstanding caption and
    // stays green when only this one loses its time — which is exactly what the
    // first version of this assertion did.
    await expect(page.getByRole('heading', { name: 'Received' })).toBeVisible();
    const receivedSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Received' }) });
    await expect(
      receivedSection.getByText(new RegExp(`Journey Flow · .* · ${slot.startTime} · `)),
    ).toBeVisible();
    // The Outstanding row carries the reminder action. On this cross-class
    // surface the aria-label appends the class context
    // ("… for {class} · {day} · {time}", #59) so two rows for one student stay
    // tellable apart.
    //
    // The assertion reaches for the start time specifically, because that is
    // the half of #59 the page owns: a bare /for / matched the pre-fix
    // two-part label just as happily, so reverting this page's `classContext`
    // left the whole suite green and nothing anywhere pinned the user-visible
    // fix. Matching `.*${slot.startTime}` pins the content without pinning the
    // separator or the order — the format stays free to change.
    await expect(
      page.getByRole('button', {
        name: new RegExp(`Send reminder to Walkin g\\. for .*${slot.startTime}`),
      }),
    ).toBeVisible();
    // The caption from the class-page send above survives the server read.
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

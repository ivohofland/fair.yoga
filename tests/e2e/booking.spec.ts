import type { BrowserContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { accountIdOfStudent } from './account-helpers';
import { uniqueSuffix, hashToken, seedSession, sessionCookie } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';
import { mintSignupTicket } from '@/lib/auth';

const prisma = new PrismaClient();

/** Stamps `context` with the origin-nonce cookie a token bound to `nonce`
 *  needs to take the same-browser branch at `/verify`. */
async function asOriginBrowser(context: BrowserContext, nonce: string): Promise<void> {
  await context.addCookies([
    { name: 'fair_yoga_origin', value: nonce, domain: 'localhost', path: '/' },
  ]);
}

const suffix = uniqueSuffix();
const slug = `e2e-booking-${suffix}`;

let teacherId: string;
let roomId: string;
let teacherRoomId: string;
let classId: string;
let secondClassId: string;
let studentId: string;

test.describe('Public booking flow', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Booking',
        lastName: 'Teacher',
        email: `e2e-booking-teacher-${suffix}@test.local`,
        account: { create: { email: `e2e-booking-teacher-${suffix}@test.local` } },
        bio: 'Vinyasa in the east of town.',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'E2E Studio',
        address: `${suffix} Booking St`,
        city: 'Amsterdam',
        postcode: '1234BK',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
    });
    teacherRoomId = teacherRoom.id;

    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'E2E Vinyasa',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      });
    classId = cls.id;

    const secondCls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'E2E Restorative',
        date: new Date('2099-06-08'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      });
    secondClassId = secondCls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Booking',
        lastName: 'Student',
        email: `e2e-booking-student-${suffix}@test.local`,
        account: { create: { email: `e2e-booking-student-${suffix}@test.local` } },
        incomeTier: 3,
        claimedAt: new Date(),
      },
    });
    studentId = student.id;
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { relatedClassId: { in: [classId, secondClassId] } },
    });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfStudent(prisma, studentId) } });
    await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
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
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('public teacher page shows the open class with a price range', async ({ page }) => {
    await page.goto(`/${slug}`);

    await expect(page.getByRole('heading', { name: 'Booking Teacher' })).toBeVisible();
    await expect(page.getByText('E2E Vinyasa')).toBeVisible();
    // Exact seeded range (room 20 + min rate 15 over the padded pair):
    // a NaN, swapped, or misindexed price must fail here, not in production.
    await expect(
      page.getByText(/€13\.79 – €20\.11 depending on your income tier/).first(),
    ).toBeVisible();

    // The pricing explainer sits above the class list, not in a footer.
    const explainer = page.getByText(/Prices are income-based/);
    await expect(explainer).toBeVisible();
    const explainerBox = await explainer.boundingBox();
    const listHeadingBox = await page
      .getByRole('heading', { name: 'Upcoming classes' })
      .boundingBox();
    expect(explainerBox!.y).toBeLessThan(listHeadingBox!.y);
  });

  test('booking page asks for an account when signed out', async ({ page }) => {
    await page.goto(`/${slug}/book/${classId}`);

    await expect(page.getByText('First time here?')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send me the link' })).toBeVisible();
    // The price range is visible before signing in.
    await expect(
      page.getByText(/€13\.79 – €20\.11 depending on your income tier/).first(),
    ).toBeVisible();
  });

  test('a live signup ticket shows the name step, and submitting it reaches the tier picker', async ({ page, context }) => {
    // Task 4's own coverage: the ticket is seeded directly the way
    // POST /api/account/student-profile finds it — a live student_signup
    // ticket cookie and no session — rather than driven through /verify.
    const email = `e2e-booking-ticket-${suffix}@test.local`;
    const rawToken = await mintSignupTicket(prisma, email, 'student');
    await context.addCookies([
      { name: 'fair_yoga_signup', value: rawToken, domain: 'localhost', path: '/' },
    ]);

    await page.goto(`/${slug}/book/${classId}`);
    await expect(page.getByText('One last thing')).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    await page.getByLabel('First name').fill('Ticket');
    await page.getByLabel('Last name').fill('Student');
    await page.getByRole('button', { name: 'Continue' }).click();

    // The response set the session cookie and router.refresh() re-rendered
    // this same page as the signed-in viewer: the tier picker, not a second
    // sign-in form.
    await expect(page.getByText('Your tier')).toBeVisible();

    const created = await prisma.student.findUniqueOrThrow({ where: { email } });
    // The two census columns from the spec's column-census table: claimed by
    // the ticket-authorized create, and with no tier chosen — the booking
    // above never touched the picker.
    expect(created.claimedAt).not.toBeNull();
    expect(created.tierSelectedAt).toBeNull();

    // This test's own rows — the shared afterAll only knows about `studentId`.
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfStudent(prisma, created.id) } });
    await prisma.student.delete({ where: { id: created.id } });
    await prisma.account.deleteMany({ where: { email } });
  });

  test('a session cookie that fails to validate blocks the ticket the same as a valid one', async ({ page, context }) => {
    // `session` (from getSession) is falsy for BOTH "no cookie" and "a
    // present cookie that doesn't validate" — this page must not read that
    // as license to fall through to the ticket, or it renders a name-step
    // form for the ticket's address that 401s on submit against the route,
    // which gates on cookie PRESENCE, not validity.
    const email = `e2e-booking-invalidsession-${suffix}@test.local`;
    const rawToken = await mintSignupTicket(prisma, email, 'student');
    await context.addCookies([
      { name: 'fair_yoga_signup', value: rawToken, domain: 'localhost', path: '/' },
      { name: 'fair_yoga_session', value: 'not-a-real-session-token', domain: 'localhost', path: '/' },
    ]);

    await page.goto(`/${slug}/book/${classId}`);

    // The sign-in form, not the name step — and never the ticket's address.
    await expect(page.getByText('First time here?')).toBeVisible();
    await expect(page.getByText('One last thing')).not.toBeVisible();
    await expect(page.getByText(email)).not.toBeVisible();

    await prisma.magicLinkToken.deleteMany({ where: { email } });
  });

  test('the whole chain: email, verify, name, tier, book — for a real fresh signup', async ({ page }) => {
    // Task 5's own coverage: unlike the test above, nothing here is seeded
    // directly — the email form is driven for real, exercising the actual
    // POST /api/auth/student-signup route this task rewrote.
    const email = `e2e-booking-fullpath-${suffix}@test.local`;
    const classPath = `/${slug}/book/${classId}`;

    await page.goto(classPath);
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Send me the link' }).click();
    await expect(page.getByText('Check your inbox')).toBeVisible();

    // "click the emailed link" — the real POST above minted its own token
    // bound to this browser's nonce, but hashes it immediately and persists
    // nothing else, so there is no way to recover it. Seed an equivalent one
    // instead, the way the real route mints it: `student_signup` purpose,
    // bound to this same browser's nonce, redirecting back to this class.
    const nonce = (await page.context().cookies()).find((c) => c.name === 'fair_yoga_origin')?.value;
    if (!nonce) throw new Error('expected fair_yoga_origin to already be set on this context');
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.magicLinkToken.create({
      data: {
        tokenHash: hashToken(rawToken),
        email,
        purpose: 'student_signup',
        redirectTo: classPath,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        originBrowserHash: hashToken(nonce),
      },
    });

    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL(`**${classPath}`, { timeout: 10_000 });

    // The ticket branch: no session yet, so the name step shows, not the
    // tier picker.
    await expect(page.getByText('One last thing')).toBeVisible();
    await page.getByLabel('First name').fill('Full');
    await page.getByLabel('Last name').fill('Path');
    await page.getByRole('button', { name: 'Continue' }).click();

    // The response set the session cookie and router.refresh() re-rendered
    // this same page as the signed-in viewer: the tier picker.
    await expect(page.getByText('Your tier')).toBeVisible();
    await page.getByRole('radio', { name: /Tier 2/ }).click();
    await page.getByRole('button', { name: /^Book — around/ }).click();
    await expect(page.getByText("You're in", { exact: true })).toBeVisible();

    const created = await prisma.student.findUniqueOrThrow({ where: { email } });
    expect(created.claimedAt).not.toBeNull();
    // The booking above stamped it — the picker showed once and never
    // shows again for this student.
    expect(created.tierSelectedAt).not.toBeNull();

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: created.id } },
    });
    expect(link).not.toBeNull();

    // This test's own rows — the shared afterAll only knows about `studentId`.
    await prisma.registration.deleteMany({ where: { studentId: created.id } });
    await prisma.teacherStudent.deleteMany({ where: { studentId: created.id } });
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfStudent(prisma, created.id) } });
    await prisma.student.delete({ where: { id: created.id } });
    await prisma.account.deleteMany({ where: { email } });
    await prisma.magicLinkToken.deleteMany({ where: { email } });
  });

  test('magic link returns the student to the booking page and books with a chosen tier', async ({ page }) => {
    // Simulate the emailed link: token with the booking page as redirect,
    // bound to this browser's nonce so it takes the same-browser branch.
    const nonce = crypto.randomBytes(16).toString('hex');
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.magicLinkToken.create({
      data: {
        tokenHash: hashToken(rawToken),
        email: `e2e-booking-student-${suffix}@test.local`,
        redirectTo: `/${slug}/book/${classId}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        originBrowserHash: hashToken(nonce),
      },
    });
    await asOriginBrowser(page.context(), nonce);

    // Freeze page timers so the 900ms redirect can't race the flash
    // assertions — the success state holds until we advance the clock.
    await page.clock.install();
    await page.goto(`/verify?token=${rawToken}`);
    // The interstitial names the actual destination — this sign-in goes
    // back to the class being booked, not to a generic "schedule".
    await expect(page.getByText('Taking you back to your class now.')).toBeVisible({
      timeout: 10_000,
    });
    // The success flash is minimal — no step rail to read in its second.
    expect(await page.getByText('Token confirmed').count()).toBe(0);
    // Release the redirect timer and land on the class.
    await page.clock.runFor(900);
    await page.waitForURL(`**/${slug}/book/${classId}`, { timeout: 10_000 });

    // The range stays in the class header when signed in too.
    await expect(page.getByText(/depending on your income tier/).first()).toBeVisible();
    // Tier selection is visible; pick tier 2 and book.
    await expect(page.getByText('Your tier')).toBeVisible();
    await page.getByRole('radio', { name: /Tier 2/ }).click();
    await page.getByRole('button', { name: /^Book — around/ }).click();

    await expect(page.getByText("You're in", { exact: true })).toBeVisible();

    // The registration exists with the chosen tier, and the roster link too.
    const registration = await prisma.registration.findFirst({
      where: { classId, studentId },
    });
    expect(registration).not.toBeNull();
    expect(registration!.tierAtBooking).toBe(2);

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(link).not.toBeNull();
  });

  test('a returning student sees their tier and the settings link, not the picker', async ({ page, context }) => {
    // The previous test booked class 1 as tier 2 — this student is now a
    // returning tier-1/2 student: summary + honesty nudge, no radiogroup.
    const sessionToken = await seedSession(prisma, await accountIdOfStudent(prisma, studentId));
    await context.addCookies([sessionCookie(sessionToken)]);

    await page.goto(`/${slug}/book/${secondClassId}`);
    await expect(page.getByText(/You're in Tier 2/)).toBeVisible();
    await expect(page.getByText('does this still reflect your situation?')).toBeVisible();
    // Their tier is settled: the header quotes the turnout spread at
    // their tier-2 numbers (a wiring bug quoting the median would show
    // €4.50 – €17.50), and the tier-spread line is gone.
    await expect(
      page.getByText(/€3\.68 – €15\.56 depending on how many join/),
    ).toBeVisible();
    await expect(page.getByText(/depending on your income tier/)).toHaveCount(0);
    // So is the footnote's tier-spread sentence — first-bookers only.
    await expect(page.getByText('The highest tier pays about twice the lowest.')).toHaveCount(0);
    // Deep-links straight to the tier page, not the settings index.
    await expect(page.getByRole('link', { name: 'Change your tier in settings' })).toHaveAttribute(
      'href',
      '/account/tier',
    );
    await expect(page.getByRole('radio')).toHaveCount(0);

    await page.getByRole('button', { name: /^Book — around/ }).click();
    await expect(page.getByText("You're in", { exact: true })).toBeVisible();

    const registration = await prisma.registration.findFirst({
      where: { classId: secondClassId, studentId },
    });
    expect(registration).not.toBeNull();
    expect(registration!.tierAtBooking).toBe(2);

    // Revisiting the class hits the alreadyBooked branch, which takes
    // precedence over the returning-student summary.
    await page.goto(`/${slug}/book/${secondClassId}`);
    await expect(page.getByText("You're booked for this class")).toBeVisible();
    // Booked: the header quote counts them once, at the tier stamped on
    // their registration. Appending them as a second joining body on top
    // of their own row would show €3.75 – €17.50.
    await expect(
      page.getByText(/€3\.68 – €15\.56 depending on how many join/),
    ).toBeVisible();
  });

  test('a first booking with the default tier untouched still stamps the choice', async ({ page, context, browser }) => {
    // The server-side stamp is the load-bearing guard (integration-
    // tested); this is the user-facing proof: book without touching a
    // radio, and the picker never comes back.
    const email = `e2e-booking-default-${suffix}@test.local`;
    const defaultStudent = await prisma.student.create({
      data: {
        firstName: 'Default',
        lastName: 'Student',
        email,
        account: { create: { email } },
        claimedAt: new Date(),
      },
    });
    const sessionToken = await seedSession(prisma, await accountIdOfStudent(prisma, defaultStudent.id));
    await context.addCookies([sessionCookie(sessionToken)]);

    await page.goto(`/${slug}/book/${classId}`);
    await expect(page.getByRole('radiogroup')).toBeVisible();
    // The tier-spread sentence belongs to this picker moment — the
    // returning test pins its absence on the other branch.
    await expect(page.getByText('The highest tier pays about twice the lowest.')).toBeVisible();
    await page.getByRole('button', { name: /^Book — around/ }).click();
    await expect(page.getByText("You're in", { exact: true })).toBeVisible();

    const reg = await prisma.registration.findFirst({
      where: { classId, studentId: defaultStudent.id },
    });
    expect(reg).not.toBeNull();
    expect(reg!.tierAtBooking).toBe(3);
    const after = await prisma.student.findUniqueOrThrow({
      where: { id: defaultStudent.id },
    });
    expect(after.tierSelectedAt).not.toBeNull();

    // The picker never returns: a different class now shows the summary.
    await page.goto(`/${slug}/book/${secondClassId}`);
    await expect(page.getByText("You're in Tier 3")).toBeVisible();
    await expect(page.getByRole('radio')).toHaveCount(0);

    // The teacher page tells this student what they already did: the
    // booked card says so, the unbooked card still quotes the range.
    await page.goto(`/${slug}`);
    await expect(page.getByText('✓ Booked')).toHaveCount(1);
    await expect(page.getByText(/depending on your income tier/)).toHaveCount(1);

    // A fresh signed-out visitor while these bookings exist: nobody's
    // booked state leaks into the anonymous view.
    const anon = await browser.newContext();
    const anonPage = await anon.newPage();
    await anonPage.goto(`/${slug}`);
    await expect(anonPage.getByText('✓ Booked')).toHaveCount(0);
    await expect(anonPage.getByText(/depending on your income tier/)).toHaveCount(2);
    await anon.close();

    // This test's own rows: student delete cascades its registration;
    // notifications are reaped by afterAll's relatedClassId cleanup.
    await prisma.session.deleteMany({ where: { id: hashToken(sessionToken) } });
    await prisma.teacherStudent.deleteMany({ where: { studentId: defaultStudent.id } });
    await prisma.student.delete({ where: { id: defaultStudent.id } });
    await prisma.account.deleteMany({ where: { email } });
  });

  test('the booking shows up under /bookings', async ({ page, context }) => {
    // Reuse an authenticated session created directly.
    const sessionToken = await seedSession(prisma, await accountIdOfStudent(prisma, studentId));
    await context.addCookies([sessionCookie(sessionToken)]);

    await page.goto('/bookings');
    await expect(page.getByRole('heading', { name: 'Your bookings' })).toBeVisible();
    // .first(): the class name also appears in the unread-updates strip.
    await expect(page.getByText('E2E Vinyasa').first()).toBeVisible();
  });

  // #389. Its own student/class/payment, created and torn down inline, so it
  // never touches the serial fixtures the tests above depend on. Cleanup
  // runs in `finally` so a failed assertion above still leaves the e2e DB
  // clean for later runs.
  test('a student owing this teacher sees the open-payments nudge while booking again', async ({
    page,
    context,
  }) => {
    const email = `e2e-booking-owes-${suffix}@test.local`;
    const otherEmail = `e2e-booking-owes-other-${suffix}@test.local`;
    let owingStudentId: string | undefined;
    let otherStudentId: string | undefined;
    let pastClsId: string | undefined;
    let sessionToken: string | undefined;

    try {
      const owingStudent = await prisma.student.create({
        data: {
          firstName: 'Owing',
          lastName: 'Student',
          email,
          account: { create: { email } },
          incomeTier: 3,
          claimedAt: new Date(),
        },
      });
      owingStudentId = owingStudent.id;

      const pastCls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'E2E Past Class',
        date: new Date('2020-01-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'completed',
        settingsLocked: true,
      });
      pastClsId = pastCls.id;
      const registration = await prisma.registration.create({
        data: {
          classId: pastCls.id,
          studentId: owingStudent.id,
          status: 'attended',
          tierAtBooking: 3,
          price: 20,
          tierRatio: 1.0,
        },
      });
      await prisma.payment.create({
        data: { registrationId: registration.id, amount: 20, status: 'pending' },
      });

      // A second student, also owing this same teacher: proves the count is
      // scoped to `owingStudent`, not just to the teacher — a dropped
      // `studentId` filter would read "2" instead of "1" below.
      const otherStudent = await prisma.student.create({
        data: {
          firstName: 'Other',
          lastName: 'Student',
          email: otherEmail,
          account: { create: { email: otherEmail } },
          incomeTier: 3,
          claimedAt: new Date(),
        },
      });
      otherStudentId = otherStudent.id;
      const otherRegistration = await prisma.registration.create({
        data: {
          classId: pastCls.id,
          studentId: otherStudent.id,
          status: 'attended',
          tierAtBooking: 3,
          price: 20,
          tierRatio: 1.0,
        },
      });
      await prisma.payment.create({
        data: { registrationId: otherRegistration.id, amount: 20, status: 'pending' },
      });

      sessionToken = await seedSession(prisma, await accountIdOfStudent(prisma, owingStudent.id));
      await context.addCookies([sessionCookie(sessionToken)]);

      await page.goto(`/${slug}/book/${classId}`);
      await expect(page.getByText('You have 1 open payment with this teacher.')).toBeVisible();
      await expect(page.getByRole('link', { name: 'View your bookings' })).toHaveAttribute(
        'href',
        '/bookings',
      );
    } finally {
      if (pastClsId) {
        await prisma.payment.deleteMany({ where: { registration: { classId: pastClsId } } });
        await prisma.registration.deleteMany({ where: { classId: pastClsId } });
        await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: pastClsId } } } });
      }
      if (sessionToken) {
        await prisma.session.deleteMany({ where: { id: hashToken(sessionToken) } });
      }
      if (owingStudentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: owingStudentId } });
        await prisma.student.delete({ where: { id: owingStudentId } });
      }
      if (otherStudentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: otherStudentId } });
        await prisma.student.delete({ where: { id: otherStudentId } });
      }
      await prisma.account.deleteMany({ where: { email: { in: [email, otherEmail] } } });
    }
  });
});

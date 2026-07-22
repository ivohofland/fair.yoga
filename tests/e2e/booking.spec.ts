import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { accountIdOfStudent } from './account-helpers';

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const slug = `e2e-booking-${uniqueSuffix}`;

let teacherId: string;
let roomId: string;
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
        email: `e2e-booking-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `e2e-booking-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Vinyasa in the east of town.',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'E2E Studio',
        address: `${uniqueSuffix} Booking St`,
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

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'E2E Vinyasa',
        date: new Date('2099-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      },
    });
    classId = cls.id;

    const secondCls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'E2E Restorative',
        date: new Date('2099-06-08'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      },
    });
    secondClassId = secondCls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Booking',
        lastName: 'Student',
        email: `e2e-booking-student-${uniqueSuffix}@test.local`,
        account: { create: { email: `e2e-booking-student-${uniqueSuffix}@test.local` } },
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
    await prisma.magicLinkToken.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    await prisma.class.deleteMany({ where: { teacherId } });
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

  test('magic link returns the student to the booking page and books with a chosen tier', async ({ page }) => {
    // Simulate the emailed link: token with the booking page as redirect.
    const rawToken = crypto.randomBytes(32).toString('hex');
    await prisma.magicLinkToken.create({
      data: {
        tokenHash: hashToken(rawToken),
        email: `e2e-booking-student-${uniqueSuffix}@test.local`,
        redirectTo: `/${slug}/book/${classId}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

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
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({
      data: {
        id: hashToken(sessionToken),
        accountId: await accountIdOfStudent(prisma, studentId),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await context.addCookies([
      { name: 'fair_yoga_session', value: sessionToken, url: 'http://localhost:3000' },
    ]);

    await page.goto(`/${slug}/book/${secondClassId}`);
    await expect(page.getByText(/You're in Tier 2/)).toBeVisible();
    await expect(page.getByText('does this still reflect your situation?')).toBeVisible();
    // Their tier is settled: the header quotes the turnout spread, not
    // the tier spread.
    await expect(page.getByText(/depending on how many join/)).toBeVisible();
    await expect(page.getByText(/depending on your income tier/)).toHaveCount(0);
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
  });

  test('a first booking with the default tier untouched still stamps the choice', async ({ page, context, browser }) => {
    // The server-side stamp is the load-bearing guard (integration-
    // tested); this is the user-facing proof: book without touching a
    // radio, and the picker never comes back.
    const email = `e2e-booking-default-${uniqueSuffix}@test.local`;
    const defaultStudent = await prisma.student.create({
      data: {
        firstName: 'Default',
        lastName: 'Student',
        email,
        account: { create: { email } },
        claimedAt: new Date(),
      },
    });
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({
      data: {
        id: hashToken(sessionToken),
        accountId: await accountIdOfStudent(prisma, defaultStudent.id),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await context.addCookies([
      { name: 'fair_yoga_session', value: sessionToken, url: 'http://localhost:3000' },
    ]);

    await page.goto(`/${slug}/book/${classId}`);
    await expect(page.getByRole('radiogroup')).toBeVisible();
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
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({
      data: {
        id: hashToken(sessionToken),
        accountId: await accountIdOfStudent(prisma, studentId),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await context.addCookies([
      {
        name: 'fair_yoga_session',
        value: sessionToken,
        url: 'http://localhost:3000',
      },
    ]);

    await page.goto('/bookings');
    await expect(page.getByRole('heading', { name: 'Your bookings' })).toBeVisible();
    // .first(): the class name also appears in the unread-updates strip.
    await expect(page.getByText('E2E Vinyasa').first()).toBeVisible();
  });
});

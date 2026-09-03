import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PrismaClient, type MagicLinkPurpose } from '@prisma/client';
import crypto from 'crypto';
import { uniqueSuffix, hashToken } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

const prisma = new PrismaClient();

/**
 * The 2×2 device-handoff matrix (#214): role (teacher/student) × flow
 * (sign-in/signup), plus the mail-scanner regression that started this —
 * opening a bound link from a browser with no matching `fair_yoga_origin`
 * cookie must show a code, not consume the token or sign anyone in.
 *
 * Every case here mints its own token directly via Prisma rather than
 * reading a real email, which this suite has no way to do.
 */

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * A token bound to `nonce`'s hash, minted the same way `deliverSignInLink`
 * binds one in production — this suite has no way to receive the real
 * email, so every case here mints and binds its own token directly.
 */
async function createBoundToken(
  email: string,
  nonce: string,
  opts?: { redirectTo?: string; purpose?: MagicLinkPurpose },
): Promise<string> {
  const rawToken = generateToken();
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: hashToken(rawToken),
      email,
      redirectTo: opts?.redirectTo ?? null,
      purpose: opts?.purpose ?? 'sign_in',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      originBrowserHash: hashToken(nonce),
    },
  });
  return rawToken;
}

/** Stamps `context` with the origin-nonce cookie a token bound to `nonce`
 *  needs to take the same-browser branch at `/verify`. */
async function asOriginBrowser(context: BrowserContext, nonce: string): Promise<void> {
  await context.addCookies([
    { name: 'fair_yoga_origin', value: nonce, domain: 'localhost', path: '/' },
  ]);
}

/** The nonce a real `ensureOriginNonce` call already stamped on `context` —
 *  for cases that trigger the cookie through an actual form submission
 *  rather than setting it by hand. */
async function readOriginNonceCookie(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies();
  const nonceCookie = cookies.find((c) => c.name === 'fair_yoga_origin');
  if (!nonceCookie) throw new Error('expected fair_yoga_origin to already be set on this context');
  return nonceCookie.value;
}

/** Reads the 6-digit code off a rendered handoff page via the element's
 *  `aria-label` (set in `verify/page.tsx`'s `HandoffState`), rather than
 *  parsing its text node. */
async function readHandoffCode(page: Page): Promise<string> {
  const codeLocator = page.locator('[aria-label^="Your code is "]');
  await expect(codeLocator).toBeVisible();
  const ariaLabel = await codeLocator.getAttribute('aria-label');
  if (!ariaLabel) throw new Error('handoff code element has no aria-label');
  return ariaLabel.replace('Your code is ', '');
}

const suffix = uniqueSuffix();
const slug = `e2e-handoff-${suffix}`;
const teacherEmail = `e2e-handoff-teacher-${suffix}@test.local`;
const teacherSignupEmail = `e2e-handoff-teacher-signup-${suffix}@test.local`;
const returningStudentEmail = `e2e-handoff-returning-${suffix}@test.local`;
const newStudentEmail = `e2e-handoff-newstudent-${suffix}@test.local`;

let teacherId: string;
let roomId: string;
let classId: string;

test.describe('Magic link device handoff', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Handoff',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Teaches the 2x2 matrix.',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Handoff Studio',
        address: `${suffix} Handoff St`,
        city: 'Amsterdam',
        postcode: '1234HD',
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

    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Handoff Vinyasa',
      date: new Date('2099-06-02'),
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

    await prisma.student.create({
      data: {
        firstName: 'Returning',
        lastName: 'Student',
        email: returningStudentEmail,
        account: { create: { email: returningStudentEmail } },
        incomeTier: 3,
        claimedAt: new Date(),
      },
    });
  });

  test.afterAll(async () => {
    const allEmails = [teacherEmail, teacherSignupEmail, returningStudentEmail, newStudentEmail];
    await prisma.magicLinkToken.deleteMany({ where: { email: { in: allEmails } } });

    const accounts = await prisma.account.findMany({
      where: { email: { in: allEmails } },
      select: { id: true },
    });
    const accountIds = accounts.map((a) => a.id);
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });

    if (teacherId) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    }
    if (roomId) {
      await prisma.room.deleteMany({ where: { id: roomId } });
    }
    await prisma.student.deleteMany({ where: { email: { in: [returningStudentEmail, newStudentEmail] } } });
    await prisma.teacher.deleteMany({ where: { email: teacherEmail } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  // Teacher x Sign-in: /login, same-browser and handoff.
  test('teacher sign-in: same-browser signs straight in; a different browser gets a code instead of a session', async ({
    page,
    browser,
  }) => {
    const nonceSame = crypto.randomBytes(16).toString('hex');
    const tokenSame = await createBoundToken(teacherEmail, nonceSame);
    await asOriginBrowser(page.context(), nonceSame);
    await page.goto(`/verify?token=${tokenSame}`);
    await page.waitForURL('/schedule', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();

    // A second token, opened from a browser that never held its nonce.
    const nonceOther = crypto.randomBytes(16).toString('hex');
    const tokenOther = await createBoundToken(teacherEmail, nonceOther);
    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    await strangerPage.goto(`/verify?token=${tokenOther}`);

    await expect(
      strangerPage.getByRole('heading', { name: 'Enter this where you started' }),
    ).toBeVisible();
    await expect(
      strangerPage.getByRole('link', { name: 'Sign in here instead' }),
    ).toBeVisible();
    const code = await readHandoffCode(strangerPage);
    expect(code).toMatch(/^\d{6}$/);

    // Nothing was consumed: the row is still there, still holding that code.
    const row = await prisma.magicLinkToken.findUnique({
      where: { tokenHash: hashToken(tokenOther) },
    });
    expect(row?.handoffCode).toBe(code);

    await strangerContext.close();
  });

  // Teacher x Signup: /signup, handoff — the ticket lands on the browser
  // that asked for the link, not the one that opened it.
  test('teacher signup: a handoff on another device still lands the ticket on the requesting browser', async ({
    browser,
  }) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await createBoundToken(teacherSignupEmail, nonce, {
      purpose: 'teacher_signup',
      redirectTo: '/signup/profile',
    });

    const requesterContext = await browser.newContext();
    await asOriginBrowser(requesterContext, nonce);
    const requesterPage = await requesterContext.newPage();

    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    await strangerPage.goto(`/verify?token=${token}`);
    await expect(
      strangerPage.getByRole('heading', { name: 'Enter this where you started' }),
    ).toBeVisible();
    const code = await readHandoffCode(strangerPage);
    await strangerContext.close();

    await requesterPage.goto('/signup');
    await requesterPage.getByLabel('Email').fill(teacherSignupEmail);
    await requesterPage.getByRole('button', { name: 'Send me the link' }).click();
    await expect(requesterPage.getByText('Check your inbox')).toBeVisible();
    await requesterPage.getByLabel('Code').fill(code);
    await requesterPage.getByRole('button', { name: 'Continue' }).click();
    await requesterPage.waitForURL('**/signup/profile', { timeout: 10_000 });

    // The ticket landed here, showing the right address — not a session,
    // since no account exists yet for this email.
    await expect(requesterPage.getByText(teacherSignupEmail)).toBeVisible();
    const requesterCookies = await requesterContext.cookies();
    expect(requesterCookies.some((c) => c.name === 'fair_yoga_signup')).toBe(true);
    expect(requesterCookies.some((c) => c.name === 'fair_yoga_session')).toBe(false);

    await requesterContext.close();
  });

  // Student x Sign-in: booking page, returning mode, same browser.
  test('student sign-in from the booking page: returning mode, same browser, lands back on the class', async ({
    page,
  }) => {
    await page.goto(`/${slug}/book/${classId}`);
    await page.getByRole('button', { name: 'Already have an account?' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await page.getByLabel('Email').fill(returningStudentEmail);
    await page.getByRole('button', { name: 'Send me the link' }).click();
    await expect(page.getByText('Check your inbox')).toBeVisible();

    // Reuse the nonce the real POST above just stamped on this browser.
    const nonce = await readOriginNonceCookie(page.context());
    const token = await createBoundToken(returningStudentEmail, nonce, {
      redirectTo: `/${slug}/book/${classId}`,
    });

    await page.goto(`/verify?token=${token}`);
    await page.waitForURL(`**/${slug}/book/${classId}`, { timeout: 10_000 });
    await expect(page.getByText(/depending on your income tier/).first()).toBeVisible();
  });

  // Student x Signup: booking page, new mode, handoff — the only cell where
  // a token's `redirectTo` and a second browser interact. Losing it drops
  // the student on /bookings instead of the class they were booking.
  test('student signup from the booking page: new mode, handoff on another device preserves the class redirect', async ({
    page,
    browser,
  }) => {
    const classPath = `/${slug}/book/${classId}`;

    await page.goto(classPath);
    // Default mode is 'new'.
    await page.getByLabel('First name').fill('Handoff');
    await page.getByLabel('Last name').fill('Student');
    await page.getByLabel('Email').fill(newStudentEmail);
    await page.getByRole('button', { name: 'Send me the link' }).click();
    await expect(page.getByText('Check your inbox')).toBeVisible();

    const nonce = await readOriginNonceCookie(page.context());

    const strangerContext = await browser.newContext();
    const strangerPage = await strangerContext.newPage();
    const token = await createBoundToken(newStudentEmail, nonce, { redirectTo: classPath });
    await strangerPage.goto(`/verify?token=${token}`);
    await expect(
      strangerPage.getByRole('heading', { name: 'Enter this where you started' }),
    ).toBeVisible();
    const code = await readHandoffCode(strangerPage);
    await strangerContext.close();

    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL(`**${classPath}`, { timeout: 10_000 });
    await expect(page.getByText(/depending on your income tier/).first()).toBeVisible();
  });

  // Scanner regression (Defect B): a link opened from a browser with no
  // origin-nonce cookie at all — not even a mismatched one — must show a
  // code and consume nothing, so the browser that actually requested it can
  // still claim it afterwards.
  test('a link opened with no origin cookie at all shows a code, and the requester can still claim it', async ({
    page,
    browser,
  }) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await createBoundToken(teacherEmail, nonce);

    const scannerContext = await browser.newContext();
    const scannerPage = await scannerContext.newPage();
    await scannerPage.goto(`/verify?token=${token}`);
    await expect(
      scannerPage.getByRole('heading', { name: 'Enter this where you started' }),
    ).toBeVisible();
    const code = await readHandoffCode(scannerPage);
    await scannerContext.close();

    await asOriginBrowser(page.context(), nonce);
    await page.goto('/login');
    await page.getByLabel('Email').fill(teacherEmail);
    await page.getByRole('button', { name: 'Send me the link' }).click();
    await expect(page.getByText('Check your inbox for the link.')).toBeVisible();
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL('/schedule', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  });
});

import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';

/**
 * Visual regression: screenshot baselines for the design system's key
 * screens. The design has no motion and system fonts, so same-platform
 * renders are stable; rendered dates are frozen to a constant string
 * (see freezeDates) and remaining dynamic text (timestamps) is masked.
 *
 * Baselines are platform-suffixed (-darwin/-linux). When a platform has
 * no baselines (currently CI/linux), the suite skips itself rather than
 * failing — regenerate with:  npx playwright test visual --update-snapshots
 */

const snapshotDir = path.join(__dirname, 'visual.spec.ts-snapshots');
const hasBaselines =
  fs.existsSync(snapshotDir) &&
  fs.readdirSync(snapshotDir).some((f) => f.includes(process.platform));
// Outside CI a missing baseline should fail loudly (it writes the actual
// for review); in CI a baseline-less platform silently has no coverage.
test.skip(Boolean(process.env.CI) && !hasBaselines, 'no visual baselines for this platform');

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const slug = `e2e-visual-${suffix}`;

let teacherId: string;
let teacherToken: string;
let roomId: string;
let classId: string;

async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([sessionCookie(teacherToken)]);
}

/** All caption/label text — relative dates and timestamps live there. */
function dynamicText(page: Page) {
  return [page.locator('.type-caption'), page.locator('.type-label')];
}

// The seeded class sits on "Tuesday of next week", so rendered dates drift
// as real time advances — and even masked date labels drift, because a
// mask's box follows the text's pixel width. Freeze every rendered date to
// one synthetic constant before screenshotting. Covers the two shapes the
// screenshotted screens render post-#96: "Tuesday, 21 Jul" (formatDayHeader
// — weekday, day-first, abbreviated month, no year) and "21 Jul 2026"
// (formatDateWithYear — day-first, abbreviated month, year, *no* weekday).
// The weekday-prefixed alternatives are tried first so a weekday-less
// alternative can't match only the tail of a weekday-prefixed date and
// leave the weekday behind unfrozen. The schedule's "Week of …" week
// heading (`class-list.tsx`'s local `weekLabel`, untouched by #96) is
// avoided by the seed date instead, not matched here — see beforeAll.
const DATE_PATTERN =
  /(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (?:(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?:, \d{4})?|\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))|\d{1,2} (?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}/;

// Looser than DATE_PATTERN on purpose: any weekday/month token that
// survives freezing — a format DATE_PATTERN doesn't know, a "Week of …"
// header, a late revert — should fail the run, not drift the baseline.
// ("May" is omitted: it's an ordinary English word.)
const DATE_SMELL =
  /\b(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|January|February|March|April|June|July|August|September|October|November|December)\b|\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d/;

// Runs in the browser via page.evaluate (hence the pattern arriving as a
// source string); returns true if it rewrote anything.
function rewriteDates(source: string): boolean {
  const pattern = new RegExp(source, 'g');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let found = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    const frozen = text.replace(pattern, 'Someday, Mmm 0');
    if (frozen !== text) {
      node.textContent = frozen;
      found = true;
    }
  }
  return found;
}

async function freezeDates(page: Page): Promise<void> {
  // React's hydration pass reverts DOM rewrites it didn't render (and, in
  // dev, pops the error-overlay badge), so a single rewrite races it.
  // Rewrite until the result survives three consecutive checks.
  let stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const rewrote = await page.evaluate(rewriteDates, DATE_PATTERN.source);
    stable = rewrote ? 0 : stable + 1;
    await page.waitForTimeout(150);
  }
  // Any date-shaped text that escapes the freeze would silently drift the
  // baseline weeks from now — fail loudly today instead.
  expect(await page.locator('body').innerText()).not.toMatch(DATE_SMELL);
}

/**
 * Teacher pages: resolve once the LiveUpdates effect opens the SSE stream.
 * Effects run only after hydration, so the request doubles as a reliable
 * "hydration finished" signal. Must be armed before page.goto.
 */
function hydrationSignal(page: Page): Promise<unknown> {
  return page.waitForResponse((r) => r.url().includes('/api/notifications/stream'));
}

const hideDevOverlay = path.join(__dirname, 'visual-hide-dev-overlay.css');

test.describe('Visual regression', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Visual',
        lastName: 'Teacher',
        email: `e2e-visual-${suffix}@test.local`,
        account: { create: { email: `e2e-visual-${suffix}@test.local` } },
        bio: 'Calm vinyasa in a warm room.',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacherId));

    const room = await prisma.room.create({
      data: {
        venueName: 'Visual Studio',
        address: `${suffix} Visual St`,
        city: 'Amsterdam',
        postcode: '1234VS',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 30 },
    });

    // Tuesday of next week: always inside the window, and the schedule's
    // week header reads the stable "Next week" on any run day (a farther
    // date would render a changing "Week of …" heading, which is not
    // masked — headers share type-subtitle with card titles).
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + (8 - (soon.getUTCDay() || 7)) + 1);
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Visual Vinyasa',
        date: new Date(Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate())),
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

    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'New booking',
        body: 'Someone booked Visual Vinyasa.',
        relatedClassId: classId,
      },
    });
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfTeacher(prisma, teacherId) } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('login', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await freezeDates(page);
    await expect(page).toHaveScreenshot('login.png', { fullPage: true, stylePath: hideDevOverlay });
  });

  test('public teacher page', async ({ page }) => {
    await page.goto(`/${slug}`);
    await expect(page.getByText('Visual Vinyasa')).toBeVisible();
    await freezeDates(page);
    await expect(page).toHaveScreenshot('public-page.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('teacher schedule', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto('/');
    await expect(page.getByText('Visual Vinyasa')).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('schedule.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('class detail (open)', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto(`/class/${classId}`);
    await expect(page.getByText('Open for registration')).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('class-detail-open.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('inbox with unread', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto('/inbox');
    await expect(page.getByText('New booking')).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('inbox.png', {
      fullPage: true,
      mask: dynamicText(page),
      stylePath: hideDevOverlay,
    });
  });

  test('settings index', async ({ page, context }) => {
    await signIn(context);
    const hydrated = hydrationSignal(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await hydrated;
    await freezeDates(page);
    await expect(page).toHaveScreenshot('settings.png', { fullPage: true, stylePath: hideDevOverlay });
  });
});

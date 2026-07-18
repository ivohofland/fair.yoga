import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

/**
 * Visual regression: screenshot baselines for the design system's key
 * screens. The design has no motion and system fonts, so same-platform
 * renders are stable; dynamic text (relative dates, timestamps) is
 * masked.
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

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const slug = `e2e-visual-${uniqueSuffix}`;
const teacherToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let roomId: string;
let classId: string;

async function signIn(context: BrowserContext): Promise<void> {
  await context.addCookies([
    { name: 'fair_yoga_session', value: teacherToken, url: 'http://localhost:3000' },
  ]);
}

/** All caption/label text — relative dates and timestamps live there. */
function dynamicText(page: Page) {
  return [page.locator('.type-caption'), page.locator('.type-label')];
}

test.describe('Visual regression', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Visual',
        lastName: 'Teacher',
        email: `e2e-visual-${uniqueSuffix}@test.local`,
        bio: 'Calm vinyasa in a warm room.',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;
    await prisma.session.create({
      data: {
        id: hashToken(teacherToken),
        userId: teacherId,
        userType: 'teacher',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const room = await prisma.room.create({
      data: {
        venueName: 'Visual Studio',
        address: `${uniqueSuffix} Visual St`,
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
    await prisma.session.deleteMany({ where: { userId: teacherId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('login', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page).toHaveScreenshot('login.png', { fullPage: true });
  });

  test('public teacher page', async ({ page }) => {
    await page.goto(`/${slug}`);
    await expect(page.getByText('Visual Vinyasa')).toBeVisible();
    await expect(page).toHaveScreenshot('public-page.png', {
      fullPage: true,
      mask: dynamicText(page),
    });
  });

  test('teacher schedule', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/');
    await expect(page.getByText('Visual Vinyasa')).toBeVisible();
    await expect(page).toHaveScreenshot('schedule.png', {
      fullPage: true,
      mask: dynamicText(page),
    });
  });

  test('class detail (open)', async ({ page, context }) => {
    await signIn(context);
    await page.goto(`/class/${classId}`);
    await expect(page.getByText('Open for registration')).toBeVisible();
    await expect(page).toHaveScreenshot('class-detail-open.png', {
      fullPage: true,
      mask: dynamicText(page),
    });
  });

  test('inbox with unread', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/inbox');
    await expect(page.getByText('New booking')).toBeVisible();
    await expect(page).toHaveScreenshot('inbox.png', {
      fullPage: true,
      mask: dynamicText(page),
    });
  });

  test('settings index', async ({ page, context }) => {
    await signIn(context);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expect(page).toHaveScreenshot('settings.png', { fullPage: true });
  });
});

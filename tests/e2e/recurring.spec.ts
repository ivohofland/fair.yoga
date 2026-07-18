import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

/**
 * The recurring-class lifecycle, end to end: template created through
 * the settings UI → the generation cron (the production trigger) fills
 * the rolling four-week window → instances are real open classes on the
 * schedule. Also pins idempotency: re-firing the cron creates nothing.
 */

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

/** CRON_SECRET from the environment (CI) or .env (local). */
function cronSecret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  const env = fs.readFileSync('.env', 'utf8');
  const match = /^CRON_SECRET=(.*)$/m.exec(env);
  if (!match) throw new Error('CRON_SECRET not found in environment or .env');
  return match[1]!.trim().replace(/^"|"$/g, '');
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const teacherToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let roomId: string;
let templateId: string;

test.describe('Recurring classes', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Recurring',
        lastName: 'Teacher',
        email: `e2e-recurring-${uniqueSuffix}@test.local`,
        bio: 'Recurring e2e fixtures',
        pageSlug: `e2e-recurring-${uniqueSuffix}`,
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
        venueName: 'Recurring Studio',
        address: `${uniqueSuffix} Recurring St`,
        city: 'Amsterdam',
        postcode: '1234RC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 25 },
    });
  });

  test.afterAll(async () => {
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.classTemplate.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { userId: teacherId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: 'fair_yoga_session', value: teacherToken, url: 'http://localhost:3000' },
    ]);
  });

  test('creates a template through settings', async ({ page }) => {
    await page.goto('/settings/recurring/new');

    await page.getByLabel('Class type').fill('Recurring Flow');
    await page.getByLabel('Room', { exact: true }).selectOption({ index: 1 });
    await page.getByLabel('Day').selectOption('Monday');
    await page.getByLabel('Start time').fill('08:15');
    await page.getByLabel('Min students').fill('1');
    await page.getByLabel('Max students').fill('8');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await page.waitForURL('**/settings/recurring', { timeout: 10_000 });
    await expect(page.getByText('Recurring Flow')).toBeVisible();
    await expect(page.getByText('Monday 08:15')).toBeVisible();

    const template = await prisma.classTemplate.findFirstOrThrow({
      where: { teacherId, classType: 'Recurring Flow' },
    });
    templateId = template.id;
    expect(template.isActive).toBe(true);
  });

  test('the generation cron fills the four-week window, idempotently', async () => {
    const fire = () =>
      fetch('http://localhost:3000/api/cron/generate-classes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cronSecret()}` },
      });

    const first = await fire();
    expect(first.status).toBe(200);

    const instances = await prisma.class.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
    });
    expect(instances.length).toBe(4);
    for (const instance of instances) {
      expect(instance.status).toBe('open');
      expect(instance.startTime).toBe('08:15');
      expect(instance.date.getUTCDay()).toBe(1); // Monday
      expect(instance.date.getTime()).toBeGreaterThan(Date.now() - 24 * 3600 * 1000);
    }

    // Re-firing must not duplicate — unique (templateId, date).
    const second = await fire();
    expect(second.status).toBe(200);
    expect(await prisma.class.count({ where: { templateId } })).toBe(4);
  });

  test('the first instance appears on the schedule as a bookable class', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Recurring Flow').first()).toBeVisible();

    const first = await prisma.class.findFirstOrThrow({
      where: { templateId },
      orderBy: { date: 'asc' },
    });
    await page.goto(`/class/${first.id}`);
    await expect(page.getByRole('heading', { name: 'Recurring Flow' })).toBeVisible();
    await expect(page.getByText('Open for registration')).toBeVisible();
  });

  test('editing the template syncs unbooked instances and says so', async ({ page }) => {
    await page.goto(`/settings/recurring/${templateId}`);
    await page.getByLabel('Start time').fill('10:00');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByText(/Applied to 4 upcoming classes\./)).toBeVisible({
      timeout: 10_000,
    });

    const instances = await prisma.class.findMany({ where: { templateId } });
    expect(instances.length).toBe(4);
    for (const instance of instances) {
      expect(instance.startTime).toBe('10:00');
    }
  });
});

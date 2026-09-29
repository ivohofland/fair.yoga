import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { uniqueSuffix, hashToken, seedSession, sessionCookie } from '../helpers';

const prisma = new PrismaClient();

const suffix = uniqueSuffix();

let teacherId: string;
let teacherToken: string;
let slug: string;

test.describe('Teacher profile photo', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    slug = `e2e-teacherphoto-${suffix}`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Photo',
        lastName: 'Teacher',
        email: `e2e-teacherphoto-${suffix}@test.local`,
        account: { create: { email: `e2e-teacherphoto-${suffix}@test.local` } },
        bio: 'Teacher photo e2e',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, teacher.accountId);
  });

  test.afterAll(async () => {
    await prisma.session.deleteMany({ where: { id: { in: [hashToken(teacherToken)] } } });
    // Deleting the Teacher cascades its TeacherPhoto.
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(teacherToken)]);
  });

  test('a teacher uploads a photo and students see it on the public page', async ({ page }) => {
    const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#1A5653' } }).jpeg().toBuffer();
    await page.goto('/settings/profile');

    // Not `getByLabel('Profile photo').setInputFiles(...)` directly: the hidden
    // input has never been focused, and setting its files without first
    // interacting races Next's hydration — React's value-tracker can
    // initialise its baseline from the already-changed value, so the native
    // `change` event reaches the DOM (confirmed with a manual listener) but
    // React's synthetic onChange never fires. Clicking the real button first
    // is both the actual user flow and avoids the race.
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Upload photo' }).click(),
    ]);
    await chooser.setFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: jpeg });

    await expect(page.getByRole('button', { name: 'Replace photo' })).toBeVisible();
    await page.goto(`/${slug}`);
    await expect(page.locator('img[src^="/api/teacher-photos/"]')).toBeVisible();

    await page.goto('/schedule');
    const profileLink = page.getByRole('link', { name: 'Profile', exact: true });
    await expect(profileLink).toHaveAttribute('href', '/settings/profile');
    await expect(profileLink.locator('img[src^="/api/teacher-photos/"]')).toBeVisible();
  });
});

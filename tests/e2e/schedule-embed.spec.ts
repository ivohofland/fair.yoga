import { test, expect } from './fixtures';
import { createGuardedPrismaClient } from './prisma';
import { BASE_URL, freshIp, uniqueSuffix, teardownTeacher } from '../helpers';
import { createClassFixture } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { mintScheduleShareKey } from '@/services/schedule-share';

/**
 * The website widget on a page that is not fair.yoga's (#916): a fake host
 * serves the snippet, the module script and the JSON come from the app across
 * origins, and the visit leaves no cookie behind.
 */

const prisma = createGuardedPrismaClient();
const suffix = uniqueSuffix();
// A `.localhost` host: another origin than BASE_URL, and a secure context, so
// Chromium's local-network check asks for a permission the test can grant
// rather than refusing outright as it does for a public `http://` page.
const TEACHER_SITE = 'http://teacher.localhost';

test.describe('<fair-yoga-schedule> on a teacher site', () => {
  test.describe.configure({ mode: 'serial' });

  const email = `e2e-embed-${suffix}@test.local`;
  const slug = `e2e-embed-${suffix}`;
  const classType = `Embed Flow ${suffix}`;
  const key = mintScheduleShareKey();
  let teacherId: string | undefined;
  let roomId: string | undefined;

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Embed', lastName: 'Teacher', bio: 'Fixture for the embed e2e', email, pageSlug: slug,
        defaultTimezone: 'UTC', scheduleShareKey: key, account: { create: { email } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;
    const room = await prisma.room.create({
      data: { venueName: 'Embed Studio', address: 'a', city: 'Amsterdam', postcode: '1000AA', maxCapacity: 10, createdById: teacherId },
    });
    roomId = room.id;
    const tr = await prisma.teacherRoom.create({ data: { teacherId, roomId, capacityOverride: 10, rentalRate: 20 } });
    const day = new Date(Date.now() + 3 * 24 * 60 * 60_000);
    await createClassFixture(prisma, {
      teacherId, teacherRoomId: tr.id, classType, date: new Date(`${day.toISOString().slice(0, 10)}T00:00:00Z`),
      startTime: hhmmToTime('10:00'), durationMinutes: 60, roomCost: 20, minRate: 10, targetRate: 30,
      minStudents: 2, maxStudents: 10, status: 'open',
    });
  });

  test.afterAll(async () => {
    if (teacherId !== undefined) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
      if (roomId !== undefined) await prisma.room.deleteMany({ where: { id: roomId } });
      await teardownTeacher(prisma, teacherId);
    }
    await prisma.$disconnect();
  });

  test('renders the schedule cross-origin and sets no cookie', async ({ page, context }) => {
    await context.clearCookies();
    await context.grantPermissions(['local-network-access'], { origin: TEACHER_SITE });
    const snippet = `<!doctype html><html><head><title>Teacher site</title></head><body>
<h1>Classes with Embed</h1>
<script type="module" src="${BASE_URL}/embed/v1.js"></script>
<fair-yoga-schedule key="${key}" theme="themed" color-scheme="auto"><a href="${BASE_URL}/${slug}">See my schedule</a></fair-yoga-schedule>
</body></html>`;
    await page.route(`${TEACHER_SITE}/**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: snippet }),
    );
    // A fresh client address per run, so the endpoint's distinct-key limit
    // never meets this spec's earlier keys. The request still leaves the
    // browser cross-origin and its response still faces the CORS check.
    const ip = freshIp();
    await page.route(`${BASE_URL}/api/public/v1/schedule/**`, (route) =>
      route.continue({ headers: { ...route.request().headers(), ...ip } }),
    );

    const scheduleResponse = page.waitForResponse((r) => r.url().includes('/api/public/v1/schedule/'));
    await page.goto(`${TEACHER_SITE}/schedule`);
    expect((await scheduleResponse).status()).toBe(200);

    const widget = page.locator('fair-yoga-schedule');
    await expect(widget.getByText(classType)).toBeVisible();
    await expect(widget.getByRole('link', { name: /Book/ })).toHaveAttribute('target', '_blank');
    await expect(widget.getByRole('link', { name: 'Add this schedule to your calendar' })).toHaveAttribute(
      'href',
      `webcal://${new URL(BASE_URL).host}/feed/${key}.ics`,
    );
    await expect(widget.getByText('See my schedule')).toHaveCount(0);

    expect(await context.cookies()).toEqual([]);
  });
});

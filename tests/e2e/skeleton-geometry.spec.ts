import { test, expect } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher } from './account-helpers';
import { hydrationSignal } from './page-helpers';
import { armHold, installFetchHold, isDevServer, prefetchSettled, releaseHold, waitForHolding } from './skeleton-hold';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';
import { createClassFixture, wallSlotAt } from '../class-fixtures';

/**
 * A tab root's loading skeleton and the page that replaces it put the header
 * and the first block below it in the same place. Each geometry test holds a
 * tab-bar navigation in its loading state (`skeleton-hold.ts`), measures the
 * skeleton, releases, and measures the page; the unheld tests below them
 * check that a natural click never paints the neutral fallback in place of
 * the route's own skeleton.
 *
 * What it does not cover: only the header and the first block below it are
 * compared (plus, for `/students`, that block's height). Blocks a page
 * renders conditionally above its first item are kept absent by the fixture
 * (see `beforeAll`), so a teacher who still sees one gets a first item the
 * skeleton does not predict. Heights of later rows are cosmetic and not
 * checked.
 */

interface RouteSpec {
  path: string;
  tab: string;
  from: string;
  /** Also compare the first item's height, not just its top. */
  compareFirstItemHeight?: boolean;
}

const ROUTES: readonly RouteSpec[] = [
  // Only /students' first item is a flagged target for height comparison:
  // its skeleton stacks SendAnnouncementSkeleton above StudentDirectorySkeleton
  // inside the same `mb-5` wrapper, and the top-only deltas below can't tell
  // a missing stacked piece from one that's merely misaligned.
  { path: '/students', tab: 'Students', from: '/schedule', compareFirstItemHeight: true },
  { path: '/inbox', tab: 'Inbox', from: '/schedule' },
  { path: '/settings', tab: 'Settings', from: '/schedule' },
  { path: '/schedule', tab: 'Schedule', from: '/inbox' },
];
const TOLERANCE_PX = 2;

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const email = `e2e-skeleton-${suffix}@test.local`;

let teacherId: string | undefined;
let roomId: string | undefined;
let teacherToken: string;

interface Geometry { headerY: number; headerHeight: number; firstItemY: number; firstItemHeight: number }

async function boxOf(locator: Locator, what: string): Promise<{ y: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${what} has no bounding box`);
  return box;
}

async function geometry(page: Page, scope: string, what: string): Promise<Geometry> {
  const header = await boxOf(page.locator(`${scope}[data-layout-anchor="header"]`), `${what} header`);
  const firstItem = await boxOf(page.locator(`${scope}[data-layout-anchor="first-item"]`), `${what} first-item`);
  return { headerY: header.y, headerHeight: header.height, firstItemY: firstItem.y, firstItemHeight: firstItem.height };
}

test.describe('Skeleton geometry', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    // The fixture settles onboarding (`isOnboardingComplete`) and dismisses
    // the install card, so the schedule's first item sits directly under its
    // header.
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Skeleton',
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: 'Slow flow, measured twice.',
        bankIban: 'NL91ABNA0417164300',
        bankAccountName: 'Skeleton Teacher',
        skippedOnboarding: ['share', 'install'],
        defaultTimezone: 'UTC',
        pageSlug: `e2e-skeleton-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacher.id));

    const room = await prisma.room.create({
      data: {
        venueName: 'Skeleton Studio',
        address: `${suffix} Skeleton St`,
        city: 'Amsterdam',
        postcode: '1234SK',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacher.id,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 12, rentalRate: 30 },
    });

    // Three days out, on the UTC teacher's wall clock: inside the schedule's
    // window on any run day, and beyond this class's auto-cancel check and
    // the morning-of reminder, either of which would leave an unread
    // notification that renames the Inbox tab mid-run.
    const slot = wallSlotAt(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), 'UTC');
    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: 'Skeleton Vinyasa',
      date: slot.date,
      startTime: slot.startTime,
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 10,
      status: 'open',
    });

    // Read, so the Inbox tab carries its plain label and no unread suffix.
    await prisma.notification.create({
      data: {
        isRead: true,
        recipientType: 'teacher',
        recipientId: teacher.id,
        type: 'booking_confirmed',
        title: 'New booking',
        body: 'Someone booked Skeleton Vinyasa.',
        relatedClassId: cls.id,
      },
    });
  });

  test.afterAll(async () => {
    if (teacherId) {
      await prisma.notification.deleteMany({ where: { recipientType: 'teacher', recipientId: teacherId } });
      await prisma.calendarEntry.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
      // Room.createdById references Teacher, so the room goes first.
      if (roomId) {
        await prisma.room.deleteMany({ where: { id: roomId } });
      }
      const accountId = await accountIdOfTeacher(prisma, teacherId);
      await prisma.session.deleteMany({ where: { accountId } });
      await prisma.teacher.deleteMany({ where: { id: teacherId } });
    }
    // Account must be deleted after Teacher, which references it.
    await prisma.account.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  for (const route of ROUTES) {
    test(`${route.path} skeleton matches its page`, async ({ page, context }) => {
      await context.addCookies([sessionCookie(teacherToken)]);
      await page.addInitScript(installFetchHold);
      const prefetched = prefetchSettled(page, route.path);
      const hydrated = hydrationSignal(page);
      await page.goto(route.from);
      await hydrated;
      if (await isDevServer(page)) {
        // The dev-tools badge sits over the Schedule tab at phone width and
        // takes its click. Hidden before either measurement, so both see the
        // same page around it.
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
      } else {
        await prefetched;
      }

      await armHold(page, route.path);
      await page.locator('nav').getByRole('link', { name: route.tab, exact: true }).click();
      await waitForHolding(page);
      await expect(page.locator('[aria-busy="true"]')).toBeVisible();
      // Under `next dev` an ancestor's fallback can paint before the held
      // response reaches the route's own boundary. The first-item anchor is
      // what the route's own skeleton adds, so measure once it is up.
      await expect(page.locator('[aria-busy="true"] [data-layout-anchor="first-item"]')).toBeVisible();
      const skeleton = await geometry(page, '[aria-busy="true"] ', 'skeleton');

      await releaseHold(page);
      await page.waitForURL(route.path);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      const loaded = await geometry(page, '', 'page');

      const deltas: Record<string, readonly [number, number]> = {
        'header top': [skeleton.headerY, loaded.headerY],
        'header height': [skeleton.headerHeight, loaded.headerHeight],
        'first-item top': [skeleton.firstItemY, loaded.firstItemY],
      };
      if (route.compareFirstItemHeight) {
        deltas['first-item height'] = [skeleton.firstItemHeight, loaded.firstItemHeight];
      }
      test.info().annotations.push({ type: 'geometry', description: JSON.stringify({ skeleton, page: loaded }) });
      // Soft, so one failing run names every anchor that moved.
      for (const [what, [fromSkeleton, fromPage]] of Object.entries(deltas)) {
        expect.soft(
          Math.abs(fromSkeleton - fromPage),
          `${route.path} ${what}: skeleton ${fromSkeleton}px, page ${fromPage}px`,
        ).toBeLessThanOrEqual(TOLERANCE_PX);
      }
    });
  }

  // Two ways the neutral fallback can paint in place of a route's own
  // skeleton (docs/design-brief.md, Loading states): under `next dev`, the
  // route's fallback renders a client component and suspends on its JS chunk,
  // so the neutral boundary above it shows instead; in a production build, the
  // prefetch stops at a neutral loading.tsx shallower than the route's own, so
  // that is what paints until the response arrives. Unheld, so this sees the
  // navigation a teacher sees: every frame that shows a loading state shows
  // the route's own, never the header-only neutral one.
  for (const route of ROUTES) {
    test(`${route.path} never paints the neutral fallback on a tab click`, async ({ page, context }) => {
      await context.addCookies([sessionCookie(teacherToken)]);
      await page.addInitScript(() => {
        const w = window as unknown as { __loadingFrames: string[] };
        w.__loadingFrames = [];
        const tick = () => {
          const busy = document.querySelector('[aria-busy="true"]');
          const state = busy === null ? 'none' : busy.querySelector('[data-layout-anchor="first-item"]') ? 'own' : 'neutral';
          if (w.__loadingFrames[w.__loadingFrames.length - 1] !== state) w.__loadingFrames.push(state);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const prefetched = prefetchSettled(page, route.path);
      const hydrated = hydrationSignal(page);
      await page.goto(route.from);
      await hydrated;
      if (await isDevServer(page)) {
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
      } else {
        await prefetched;
      }
      // Only the navigation's frames: the document load before it streams in
      // through its own boundaries.
      await page.evaluate(() => { (window as unknown as { __loadingFrames: string[] }).__loadingFrames = []; });

      await page.locator('nav').getByRole('link', { name: route.tab, exact: true }).click();
      await page.waitForURL(route.path);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      const frames = await page.evaluate(() => (window as unknown as { __loadingFrames: string[] }).__loadingFrames);
      test.info().annotations.push({ type: 'frames', description: frames.join(' → ') });
      expect(frames, `${route.path} frames: ${frames.join(' → ')}`).not.toContain('neutral');
    });
  }
});

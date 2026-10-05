import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie, BASE_URL } from '../helpers';
import { createClassFixture, wallSlotAt } from '../class-fixtures';

/**
 * Read-only offline (#725), end to end. The design and what each cache holds:
 * docs/technical-architecture.md (Offline (service worker)).
 *
 * The worker is allowed to run below (the config blocks it by default), and
 * `setOffline` only reaches worker fetches when it is.
 */

test.use({ serviceWorkers: 'allow' });

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const FIRST_NAME = 'Zephyrine';

let teacherId: string | undefined;
let roomId: string | undefined;
let classId: string | undefined;
let studentId: string | undefined;
let teacherToken: string;

/** The queued check-in test's own teacher, class and students. */
const CHECKIN_FIRST_NAMES = ['Quillon', 'Rosamund', 'Thaddeus'] as const;
let checkinTeacherId: string | undefined;
let checkinClassId: string | undefined;
const checkinStudentIds: string[] = [];
let checkinTeacherToken: string;

/** Today's class for a UTC teacher: two hours out, but never past 23:00 UTC, so it cannot roll into tomorrow late in the day. */
function classStart(): Date {
  const now = new Date();
  const twoHoursOut = now.getTime() + 2 * 60 * 60 * 1000;
  const lateToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 0);
  const start = Math.min(twoHoursOut, lateToday);
  return new Date(Math.floor(start / 60_000) * 60_000);
}

/** A class under way: started five minutes ago, but never before 00:00 UTC today, so its date is today. */
function checkinClassStart(): Date {
  const now = new Date();
  const fiveMinutesAgo = now.getTime() - 5 * 60 * 1000;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = Math.max(fiveMinutesAgo, startOfToday);
  return new Date(Math.floor(start / 60_000) * 60_000);
}

/** Whether the worker holds `path` and every static file its stored body names. */
function storedWithItsFiles(page: Page, path: string): Promise<boolean> {
  return page.evaluate(async (p) => {
    const stored = await (await caches.open('fy-pages-v1')).match(p);
    if (!stored) return false;
    const named = new Set((await stored.text()).match(/\/_next\/static\/[^"'\\\s)<>]+/g) ?? []);
    const files = await caches.open('fy-static-v1');
    for (const file of named) if (!(await files.match(file))) return false;
    return named.size > 0;
  }, path);
}

test.describe('Offline schedule', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Chromium project only');
    // From 23:00 UTC the class below has started, and a running scheduler moves it to in_progress, which has no "Cancel class" button. Why CI is exempt: docs/technical-architecture.md, "Offline (service worker)" → End-to-end.
    test.skip(
      !process.env.CI && new Date().getUTCHours() === 23,
      'The class started at 23:00 UTC would be moved to in_progress by a local scheduler; run again after midnight UTC.',
    );
    // `next dev` names its HMR client chunk in every page; a production build never does.
    const html = await (await fetch(`${BASE_URL}/login`)).text();
    // On CI the browser proof must fail, never silently vanish.
    if (process.env.CI && html.includes('hmr-client')) {
      throw new Error('The offline spec needs a production build, but the server at BASE_URL is a dev server.');
    }
    test.skip(
      html.includes('hmr-client'),
      'Needs a production build: next dev lazily loads chunks the worker never stores (docs/technical-architecture.md, "Offline (service worker)").',
    );
    await prisma.$connect();
    const email = `e2e-offline-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Offline',
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: 'Teacher for the offline e2e test',
        pageSlug: `e2e-offline-${suffix}`,
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacher.id));

    const room = await prisma.room.create({
      data: {
        venueName: 'Offline Studio',
        address: `${suffix} Offline St`,
        city: 'Amsterdam',
        postcode: '1234OF',
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

    const { date, startTime } = wallSlotAt(classStart(), 'UTC');
    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: 'Offline Vinyasa',
      date,
      startTime,
      durationMinutes: 30,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open',
    });
    classId = cls.id;

    const studentEmail = `e2e-offline-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: FIRST_NAME,
        lastName: 'Student',
        email: studentEmail,
        account: { create: { email: studentEmail } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    studentId = student.id;
    await prisma.registration.create({
      data: { classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 3 },
    });

    const checkinEmail = `e2e-offline-checkin-teacher-${suffix}@test.local`;
    const checkinTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Checkin',
        lastName: 'Teacher',
        email: checkinEmail,
        account: { create: { email: checkinEmail } },
        bio: 'Teacher for the queued check-in e2e test',
        pageSlug: `e2e-offline-checkin-${suffix}`,
        defaultTimezone: 'UTC',
      },
    });
    checkinTeacherId = checkinTeacher.id;
    checkinTeacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, checkinTeacher.id));
    const checkinRoom = await prisma.teacherRoom.create({
      data: { teacherId: checkinTeacher.id, roomId: room.id, capacityOverride: 12, rentalRate: 30 },
    });
    const checkinSlot = wallSlotAt(checkinClassStart(), 'UTC');
    const checkinClass = await createClassFixture(prisma, {
      teacherId: checkinTeacher.id,
      teacherRoomId: checkinRoom.id,
      classType: 'Offline Check-in',
      date: checkinSlot.date,
      startTime: checkinSlot.startTime,
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'in_progress',
    });
    checkinClassId = checkinClass.id;
    for (const firstName of CHECKIN_FIRST_NAMES) {
      const email = `e2e-offline-checkin-${firstName.toLowerCase()}-${suffix}@test.local`;
      const s = await prisma.student.create({
        data: {
          firstName,
          lastName: 'Student',
          email,
          account: { create: { email } },
          claimedAt: new Date(),
          incomeTier: 3,
        },
      });
      checkinStudentIds.push(s.id);
      await prisma.registration.create({
        data: { classId: checkinClass.id, studentId: s.id, status: 'registered', tierAtBooking: 3 },
      });
    }
  });

  test.afterAll(async () => {
    try {
      if (classId) await prisma.registration.deleteMany({ where: { classId } });
      if (teacherId) {
        await prisma.calendarEntry.deleteMany({ where: { teacherId } });
        await prisma.teacherRoom.deleteMany({ where: { teacherId } });
        const accountId = await accountIdOfTeacher(prisma, teacherId);
        await prisma.session.deleteMany({ where: { accountId } });
      }
      if (checkinClassId) await prisma.registration.deleteMany({ where: { classId: checkinClassId } });
      if (checkinTeacherId) {
        await prisma.calendarEntry.deleteMany({ where: { teacherId: checkinTeacherId } });
        await prisma.teacherRoom.deleteMany({ where: { teacherId: checkinTeacherId } });
        const accountId = await accountIdOfTeacher(prisma, checkinTeacherId);
        await prisma.session.deleteMany({ where: { accountId } });
      }
      if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
      if (checkinStudentIds.length > 0) {
        const students = await prisma.student.findMany({
          where: { id: { in: checkinStudentIds } },
          select: { accountId: true },
        });
        await prisma.student.deleteMany({ where: { id: { in: checkinStudentIds } } });
        const accountIds = students.flatMap((s) => (s.accountId ? [s.accountId] : []));
        if (accountIds.length > 0) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
      }
      if (checkinTeacherId) {
        const teacher = await prisma.teacher.findUnique({
          where: { id: checkinTeacherId },
          select: { accountId: true },
        });
        await prisma.teacher.deleteMany({ where: { id: checkinTeacherId } });
        if (teacher?.accountId) await prisma.account.deleteMany({ where: { id: teacher.accountId } });
      }
      if (studentId) {
        const student = await prisma.student.findUnique({ where: { id: studentId }, select: { accountId: true } });
        await prisma.student.deleteMany({ where: { id: studentId } });
        if (student?.accountId) await prisma.account.deleteMany({ where: { id: student.accountId } });
      }
      if (teacherId) {
        const teacher = await prisma.teacher.findUnique({ where: { id: teacherId }, select: { accountId: true } });
        await prisma.teacher.deleteMany({ where: { id: teacherId } });
        if (teacher?.accountId) await prisma.account.deleteMany({ where: { id: teacher.accountId } });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  test('a class never opened is stored, read offline, and wiped on sign-out', async ({ page, context }) => {
    await context.addCookies([sessionCookie(teacherToken)]);

    await page.goto('/schedule');
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));

    // Warmed from the schedule, never visited. Every static file the stored
    // page names must be stored too, or the offline page hydrates against a gap.
    await expect
      .poll(() => storedWithItsFiles(page, `/class/${classId}`), { timeout: 20_000 })
      .toBe(true);

    await context.setOffline(true);

    await page.goto(`/class/${classId}`);
    await expect(page.getByText(FIRST_NAME).first()).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toHaveText(
      /^Offline — showing what was loaded at \d{2}:\d{2}$/,
    );
    // A raw button with no `disabled:` variant of its own: the dimming below can only come from the fieldset rule in globals.css.
    const cancel = page.getByRole('button', { name: 'Cancel class' });
    await expect(cancel).toBeDisabled();
    await expect(cancel).toHaveCSS('opacity', '0.5');

    await page.goto('/');
    await expect(page).toHaveURL(/\/schedule$/);
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
    await expect(page.getByText('Offline Vinyasa').first()).toBeVisible();

    await page.goto('/students');
    await expect(page.getByText("You're offline")).toBeVisible();

    await context.setOffline(false);
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/\/login/);

    await expect
      .poll(() =>
        page.evaluate(async () =>
          (await caches.has('fy-pages-v1')) ? (await (await caches.open('fy-pages-v1')).keys()).length : 0,
        ),
      )
      .toBe(0);

    await context.setOffline(true);
    await page.goto(`/class/${classId}`);
    await expect(page.getByText("You're offline")).toBeVisible();
    await expect(page.getByText(FIRST_NAME)).toHaveCount(0);
  });

  test('check-in taps made offline survive a reload and sync when the connection returns', async ({
    page,
    context,
  }) => {
    const classId = checkinClassId;
    if (!classId) throw new Error('beforeAll did not create the check-in class');
    await context.addCookies([sessionCookie(checkinTeacherToken)]);
    const path = `/class/${classId}`;

    await page.goto(path);
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await expect.poll(() => storedWithItsFiles(page, path), { timeout: 20_000 }).toBe(true);

    await context.setOffline(true);
    for (const firstName of CHECKIN_FIRST_NAMES) {
      await page.getByRole('button', { name: `Mark ${firstName}` }).click();
    }
    const waiting = page.getByText('Waiting to sync', { exact: true });
    await expect(waiting).toHaveCount(CHECKIN_FIRST_NAMES.length);

    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
    await expect(waiting).toHaveCount(CHECKIN_FIRST_NAMES.length);
    const queued = page.getByText('3 attendance changes waiting to sync');
    await expect(queued).toBeVisible();

    await context.setOffline(false);
    await expect(queued).toHaveCount(0, { timeout: 30_000 });
    await expect(waiting).toHaveCount(0);

    const rows = await prisma.registration.findMany({
      where: { classId },
      select: { studentId: true, status: true },
    });
    expect(rows.map((r) => r.status)).toEqual(CHECKIN_FIRST_NAMES.map(() => 'attended'));
    expect(new Set(rows.map((r) => r.studentId))).toEqual(new Set(checkinStudentIds));
  });
});

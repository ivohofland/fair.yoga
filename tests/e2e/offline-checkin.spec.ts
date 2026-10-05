import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie, BASE_URL } from '../helpers';
import { createClassFixture, wallSlotAt } from '../class-fixtures';
import { reloadHydrated } from './page-helpers';

/**
 * Queued offline check-in (#726), end to end: attendance marked with no
 * connection is queued, synced on reconnect, and stays shown as synced; and
 * on the cached class page offline, every enabled control is one marked to
 * work offline (`data-offline-writable`). The design: docs/technical-architecture.md (Offline
 * (service worker) → The attendance outbox).
 *
 * Like `offline.spec.ts`, the worker is allowed here (the config blocks it by
 * default) and the spec needs a production build.
 */

test.use({ serviceWorkers: 'allow' });

const prisma = new PrismaClient();
const suffix = uniqueSuffix();
const STUDENT_NAMES = ['Oriane', 'Bastiaan', 'Wilhelmina'] as const;

let teacherId: string | undefined;
let roomId: string | undefined;
let checkinClassId: string | undefined;
let finishingClassId: string | undefined;
let checkinAt: Date;
const studentIds: string[] = [];
const registrationIds: string[] = [];
let teacherToken: string;

/**
 * A fixed-offset zone in which it is now between 12:00 and 13:00, so both
 * classes below fall on the teacher's today whatever the UTC hour — the
 * schedule warms only today's pages. `Etc/GMT` names invert the sign.
 */
function noonZone(): string {
  const offset = 12 - new Date().getUTCHours();
  return offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

function minuteFloor(ms: number): Date {
  return new Date(Math.floor(ms / 60_000) * 60_000);
}

/** A row's toggle by its accessible name; the teacher sees each student under their privacy-limited name. */
function markAs(firstName: string, target: 'present' | 'no-show'): RegExp {
  return new RegExp(`^Mark ${firstName}\\b.* as ${target}$`);
}

/** Enabled form controls that would work offline without saying so: each one escaped every fieldset. */
function escapedControls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button, input, select, textarea'))
      .filter((el) => !el.matches(':disabled') && !el.hasAttribute('data-offline-writable'))
      .map((el) => el.outerHTML.slice(0, 160)),
  );
}

/** Polls until the worker holds `path` with `needle` in its body. */
async function expectStored(page: Page, path: string, needle: string): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect
    .poll(
      () =>
        page.evaluate(
          async ([p, n]) => {
            const stored = await (await caches.open('fy-pages-v1')).match(p);
            return stored ? (await stored.text()).includes(n) : false;
          },
          [path, needle] as const,
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** No mark waiting, and every row reads Present with a toggle to no-show. */
async function expectSyncedRows(page: Page): Promise<void> {
  await expect(page.getByText(/changes? waiting to sync/)).toHaveCount(0);
  for (const name of STUDENT_NAMES) {
    await expect(page.getByRole('button', { name: markAs(name, 'no-show') })).toBeVisible();
  }
  await expect(page.getByText('Present', { exact: true })).toHaveCount(STUDENT_NAMES.length);
}

async function expectOfflineMarker(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toHaveText(/^Offline — showing what was loaded/);
}

test.describe('Offline check-in', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium', 'Chromium project only');
    // `next dev` names its HMR client chunk in every page; a production build never does.
    const html = await (await fetch(`${BASE_URL}/login`)).text();
    if (process.env.CI && html.includes('hmr-client')) {
      throw new Error('The offline check-in spec needs a production build, but the server at BASE_URL is a dev server.');
    }
    test.skip(
      html.includes('hmr-client'),
      'Needs a production build: next dev lazily loads chunks the worker never stores (docs/technical-architecture.md, "Offline (service worker)").',
    );
    await prisma.$connect();
    const timeZone = noonZone();
    const email = `e2e-offline-checkin-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Checkin',
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: 'Teacher for the offline check-in e2e test',
        pageSlug: `e2e-offline-checkin-${suffix}`,
        defaultTimezone: timeZone,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacher.id));

    const room = await prisma.room.create({
      data: {
        venueName: 'Checkin Studio',
        address: `${suffix} Checkin St`,
        city: 'Amsterdam',
        postcode: '1234CI',
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
    const economics = {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      durationMinutes: 30,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
    };

    // Check-in opens 30 minutes from now: the warm below happens before it.
    const checkinStart = minuteFloor(Date.now() + 45 * 60_000);
    checkinAt = new Date(checkinStart.getTime() - 15 * 60_000);
    const checkinClass = await createClassFixture(prisma, {
      ...economics,
      classType: 'Basement Hatha',
      ...wallSlotAt(checkinStart, timeZone),
      status: 'open',
    });
    checkinClassId = checkinClass.id;

    // Started 20 minutes ago, ends in 10: inside its finish window.
    const finishingClass = await createClassFixture(prisma, {
      ...economics,
      classType: 'Finishing Yin',
      ...wallSlotAt(minuteFloor(Date.now() - 20 * 60_000), timeZone),
      status: 'in_progress',
    });
    finishingClassId = finishingClass.id;

    for (const [i, firstName] of STUDENT_NAMES.entries()) {
      const studentEmail = `e2e-offline-checkin-student-${i}-${suffix}@test.local`;
      const student = await prisma.student.create({
        data: {
          firstName,
          lastName: 'Student',
          email: studentEmail,
          account: { create: { email: studentEmail } },
          claimedAt: new Date(),
          incomeTier: 3,
        },
      });
      studentIds.push(student.id);
      const registration = await prisma.registration.create({
        data: { classId: checkinClass.id, studentId: student.id, status: 'registered', tierAtBooking: 3 },
      });
      registrationIds.push(registration.id);
    }
    const [firstStudentId] = studentIds;
    if (firstStudentId === undefined) throw new Error('no student was seeded');
    await prisma.registration.create({
      data: { classId: finishingClass.id, studentId: firstStudentId, status: 'attended', tierAtBooking: 3 },
    });
  });

  test.afterAll(async () => {
    try {
      const classIds = [checkinClassId, finishingClassId].filter((id): id is string => id !== undefined);
      if (classIds.length) {
        await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
        await prisma.payment.deleteMany({ where: { registration: { classId: { in: classIds } } } });
        await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
      }
      if (teacherId) {
        await prisma.notification.deleteMany({ where: { recipientId: teacherId } });
        await prisma.calendarEntry.deleteMany({ where: { teacherId } });
        await prisma.teacherRoom.deleteMany({ where: { teacherId } });
        await prisma.teacherStudent.deleteMany({ where: { teacherId } });
        const accountId = await accountIdOfTeacher(prisma, teacherId);
        await prisma.session.deleteMany({ where: { accountId } });
      }
      if (roomId) await prisma.room.deleteMany({ where: { id: roomId } });
      if (studentIds.length) {
        await prisma.notification.deleteMany({ where: { recipientId: { in: studentIds } } });
        const students = await prisma.student.findMany({
          where: { id: { in: studentIds } },
          select: { accountId: true },
        });
        await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
        const accountIds = students.map((s) => s.accountId).filter((id): id is string => id !== null);
        if (accountIds.length) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
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

  test('marks taken offline after the warm sync on reconnect and stay shown as saved', async ({ page, context }) => {
    await context.addCookies([sessionCookie(teacherToken)]);
    // By registration, not by response: a mark the old document's sync had
    // already sent may be sent again by the next one and answer `unchanged`.
    const written = new Set<string>();
    const sentTargets = new Set<unknown>();
    let putsSent = 0;
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/registrations/')) {
        putsSent++;
        sentTargets.add((req.postDataJSON() as { status?: unknown } | null)?.status);
      }
    });
    page.on('response', (res) => {
      if (res.request().method() === 'PUT' && res.url().includes('/api/registrations/') && res.status() === 200) {
        written.add(new URL(res.url()).pathname);
      }
    });
    const expectedWrites = registrationIds.map((id) => `/api/registrations/${id}`).sort();

    // Warmed from the schedule while the class is still before check-in.
    await page.goto('/schedule');
    await expectStored(page, `/class/${checkinClassId}`, 'Basement Hatha');

    // The device clock passes the check-in instant; the stored page predates it.
    await page.clock.setSystemTime(checkinAt.getTime() + 60_000);
    await context.setOffline(true);
    await page.goto(`/class/${checkinClassId}`);
    await expectOfflineMarker(page);

    for (const name of STUDENT_NAMES) {
      const toggle = page.getByRole('button', { name: markAs(name, 'present') });
      await expect(toggle).toBeEnabled();
      await toggle.click();
    }
    await expect(page.getByText('3 changes waiting to sync')).toBeVisible();
    await expect(page.getByText('Waiting to sync', { exact: true })).toHaveCount(STUDENT_NAMES.length);
    // D9's tether on the check-in view the device clock opened.
    expect(await escapedControls(page)).toEqual([]);

    // The same document, no reload: these are its own taps, so the sync
    // refreshes nothing and only the confirmations can turn the rows Present.
    await context.setOffline(false);
    await expectSyncedRows(page);

    await page.reload();
    await expectSyncedRows(page);
    await expect
      .poll(() =>
        prisma.registration.count({ where: { id: { in: registrationIds }, status: 'attended' } }),
      )
      .toBe(STUDENT_NAMES.length);
    expect([...written].sort()).toEqual(expectedWrites);

    // Further reconnects and reloads replay nothing: the queue is empty. The
    // rows read Present from the server's render, before hydration; the PUT a
    // replay would send comes from OutboxSync's mount flush, which runs in the
    // same effects pass that opens the stream `reloadHydrated` waits for.
    const putsBefore = putsSent;
    for (let i = 0; i < 2; i++) {
      await context.setOffline(true);
      await context.setOffline(false);
      await reloadHydrated(page);
      await expect(page.getByText('Present', { exact: true })).toHaveCount(STUDENT_NAMES.length);
    }
    expect(putsSent).toBe(putsBefore);
    expect([...written].sort()).toEqual(expectedWrites);
    expect([...sentTargets]).toEqual(['attended']);
    expect(
      await prisma.registration.count({ where: { id: { in: registrationIds }, status: 'attended' } }),
    ).toBe(STUDENT_NAMES.length);
  });

  test('offline, only the controls meant to work offline are enabled, in the finish window and once completed', async ({
    page,
    context,
  }) => {
    await context.addCookies([sessionCookie(teacherToken)]);
    const path = `/class/${finishingClassId}`;

    // (1) In the finish window: the header carries the Finish button.
    await page.goto(path);
    await expect(page.getByRole('button', { name: 'Finish class' })).toBeEnabled();
    await expectStored(page, path, 'Finishing Yin');
    await context.setOffline(true);
    await page.reload();
    await expectOfflineMarker(page);
    await expect(page.getByRole('button', { name: markAs(STUDENT_NAMES[0], 'no-show') })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Finish class' })).toBeDisabled();
    expect(await escapedControls(page)).toEqual([]);

    // (2) Completed: "Edit attendance" unlocks the rows.
    await context.setOffline(false);
    const completed = await page.request.post(`/api/classes/${finishingClassId}/complete`);
    expect(completed.status()).toBe(200);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit attendance' })).toBeVisible();
    await expectStored(page, path, 'Edit attendance');
    await context.setOffline(true);
    await page.reload();
    await expectOfflineMarker(page);
    await page.getByRole('button', { name: 'Edit attendance' }).click();
    await expect(page.getByRole('button', { name: markAs(STUDENT_NAMES[0], 'no-show') })).toBeEnabled();
    expect(await escapedControls(page)).toEqual([]);
  });
});

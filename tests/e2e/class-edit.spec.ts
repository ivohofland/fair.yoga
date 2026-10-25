import { test, expect } from './fixtures';
import { createGuardedPrismaClient } from './prisma';
import { uniqueSuffix, hashToken, seedSession, sessionCookie } from '../helpers';
import { hhmmToTime, timeToHHmm } from '@/lib/time-of-day';
import { createClassFixture, wallSlotAt } from '../class-fixtures';

const prisma = createGuardedPrismaClient();

const suffix = uniqueSuffix();

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

async function mkNearClass(startAt: Date, status: 'draft' | 'open') {
  return createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Late Hatha',
    ...wallSlotAt(startAt, teacherTimezone),
    durationMinutes: 60,
    roomCost: 30,
    minRate: 12,
    targetRate: 20,
    minStudents: 2,
    maxStudents: 10,
    status,
    cancelDeadline: 'HOURS_12',
    autoCancelCheck: 'HOURS_2',
  });
}

let teacherId: string;
let teacherToken: string;
let otherTeacherId: string;
let otherTeacherToken: string;
let roomId: string;
let draftClassId: string;
let lockedClassId: string;
let cancelledClassId: string;
let pastDeadlineDraftId: string;
let pastCheckDraftId: string;
let openInsideDeadlineId: string;
let crossingDraftId: string;
let movableOpenId: string;
let studentId: string;
let teacherRoomId: string;
let teacherTimezone: string;

test.describe('Class edit screen', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Editing',
        lastName: 'Teacher',
        email: `e2e-classedit-teacher-${suffix}@test.local`,
        account: { create: { email: `e2e-classedit-teacher-${suffix}@test.local` } },
        bio: 'Class edit e2e',
        pageSlug: `e2e-classedit-${suffix}`,
        // UTC, so a wall slot names exactly one instant.
        defaultTimezone: 'UTC',
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, teacher.accountId);

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `e2e-classedit-other-${suffix}@test.local`,
        account: { create: { email: `e2e-classedit-other-${suffix}@test.local` } },
        bio: 'Ownership fixture',
        pageSlug: `e2e-classedit-other-${suffix}`,
      },
    });
    otherTeacherId = other.id;
    otherTeacherToken = await seedSession(prisma, other.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Edit Studio',
        address: `${suffix} Edit St`,
        city: 'Amsterdam',
        postcode: '1234ED',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
    });
    teacherRoomId = teacherRoom.id;
    teacherTimezone = teacher.defaultTimezone;

    async function mkClass(status: 'draft' | 'open' | 'cancelled', locked: boolean, day: string) {
      return createClassFixture(prisma, {
          teacherId,
          teacherRoomId: teacherRoom.id,
          classType: 'Editable Hatha',
          date: new Date(day),
          startTime: hhmmToTime('10:00'),
          durationMinutes: 60,
          roomCost: 30,
          minRate: 12,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 10,
          status: status === 'cancelled' ? 'open' : status,
          cancelledAt: status === 'cancelled' ? new Date() : null,
          settingsLocked: locked,
        });
    }
    draftClassId = (await mkClass('draft', false, '2099-07-01')).id;
    lockedClassId = (await mkClass('open', true, '2099-07-08')).id;
    cancelledClassId = (await mkClass('cancelled', false, '2099-07-15')).id;

    // Near-now classes an hour or more apart, so their windows never overlap.
    pastDeadlineDraftId = (await mkNearClass(new Date(Date.now() + 3 * HOUR), 'draft')).id;
    pastCheckDraftId = (await mkNearClass(new Date(Date.now() + 1 * HOUR), 'draft')).id;
    openInsideDeadlineId = (await mkNearClass(new Date(Date.now() + 5 * HOUR), 'open')).id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Locked',
        lastName: 'Student',
        email: `e2e-classedit-student-${suffix}@test.local`,
      },
    });
    studentId = student.id;
    await prisma.registration.create({
      data: { classId: lockedClassId, studentId, status: 'registered', tierAtBooking: 3 },
    });
  });

  test.afterAll(async () => {
    await prisma.session.deleteMany({
      where: { id: { in: [hashToken(teacherToken), hashToken(otherTeacherToken)] } },
    });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    const classIds = [
      draftClassId,
      lockedClassId,
      cancelledClassId,
      pastDeadlineDraftId,
      pastCheckDraftId,
      openInsideDeadlineId,
      crossingDraftId,
      movableOpenId,
    ].filter(Boolean);
    if (classIds.length) {
      await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
    }
    if (teacherId) await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (studentId) await prisma.student.delete({ where: { id: studentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(teacherToken)]);
  });

  test('a draft far from its start warns of nothing', async ({ page }) => {
    await page.goto(`/class/${draftClassId}`);
    await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
    await expect(page.getByText('cancellation deadline')).toHaveCount(0);
  });

  test('a draft inside its deadline warns that bookers cannot cancel free', async ({ page }) => {
    await page.goto(`/class/${pastDeadlineDraftId}`);
    await expect(page.getByText(/can't cancel for free/)).toBeVisible();
    await expect(page.getByText(/goes ahead/)).toHaveCount(0);
  });

  test('a draft past its auto-cancel check also warns that it goes ahead', async ({ page }) => {
    await page.goto(`/class/${pastCheckDraftId}`);
    await expect(page.getByText(/can't cancel for free/)).toBeVisible();
    await expect(page.getByText(/goes ahead/)).toBeVisible();
  });

  test('an open class inside its deadline shows no late-publish notice', async ({ page }) => {
    await page.goto(`/class/${openInsideDeadlineId}`);
    await expect(page.getByRole('link', { name: 'Edit class' })).toBeVisible();
    await expect(page.getByText(/can't cancel for free/)).toHaveCount(0);
  });

  test('a draft left open across its deadline picks up the notice without a reload', async ({ page }) => {
    test.setTimeout(150_000);
    // The first whole minute whose deadline (12 h before) is at least 15 s away.
    const start = new Date(Math.ceil((Date.now() + 12 * HOUR + 15_000) / MINUTE) * MINUTE);
    crossingDraftId = (await mkNearClass(start, 'draft')).id;

    await page.goto(`/class/${crossingDraftId}`);
    await expect(page.getByRole('button', { name: 'Publish' })).toBeVisible();
    await expect(page.getByText(/can't cancel for free/)).toHaveCount(0);
    await expect(page.getByText(/can't cancel for free/)).toBeVisible({ timeout: 100_000 });
  });

  test('moving an open class inside its deadline warns, and restoring its time clears it', async ({ page }) => {
    const farStart = new Date(Math.ceil((Date.now() + 72 * HOUR) / MINUTE) * MINUTE);
    const far = wallSlotAt(farStart, teacherTimezone);
    movableOpenId = (await mkNearClass(farStart, 'open')).id;
    const near = wallSlotAt(new Date(Date.now() + 8 * HOUR), teacherTimezone);

    await page.goto(`/class/${movableOpenId}/edit`);
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeVisible();
    await expect(page.getByText(/The new start is inside/)).toHaveCount(0);

    await page.getByLabel('Date').fill(near.date.toISOString().slice(0, 10));
    await page.getByLabel('Start time').fill(timeToHHmm(near.startTime));
    await expect(page.getByText(/can't cancel for free/)).toBeVisible();

    await page.getByLabel('Date').fill(far.date.toISOString().slice(0, 10));
    await page.getByLabel('Start time').fill(timeToHHmm(far.startTime));
    await expect(page.getByText(/The new start is inside/)).toHaveCount(0);
  });

  test('a draft edits fully — details and economics', async ({ page }) => {
    await page.goto(`/class/${draftClassId}`);
    await page.getByRole('link', { name: 'Edit class' }).click();
    await page.waitForURL(`**/class/${draftClassId}/edit`);

    await page.getByLabel('Class type').fill('Morning Hatha');
    // Typed key by key: a decimal comma is what a Dutch teacher types, and
    // `fill` is not a stand-in for it.
    await page.getByLabel('Target rate (€)').clear();
    await page.getByLabel('Target rate (€)').pressSequentially('24,5');
    // The date field is the one whose route conversion this PR fixed —
    // change it explicitly so the round trip is canonical coverage.
    await page.getByLabel('Date').fill('2099-07-02');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    const cls = await prisma.class.findUniqueOrThrow({ where: { id: draftClassId }, include: { calendarEntry: true } });
    expect(cls.calendarEntry.classType).toBe('Morning Hatha');
    expect(Number(cls.targetRate)).toBe(24.5);
    expect(cls.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-07-02');
  });

  test('a registration landing mid-edit locks the save out, loudly', async ({ page }) => {
    // The form loaded unlocked; the lock flips underneath (a student
    // registered); the save must 409 with the reason visible and the
    // database untouched — the fairness invariant's last line of defense.
    await page.goto(`/class/${draftClassId}/edit`);
    await expect(page.getByLabel('Target rate (€)')).toBeEnabled();

    await prisma.class.update({
      where: { id: draftClassId },
      data: { settingsLocked: true },
    });

    await page.getByLabel('Target rate (€)').fill('99');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(
      page.getByText('Prices and capacity are locked once the first student books.'),
    ).toBeVisible();

    const cls = await prisma.class.findUniqueOrThrow({ where: { id: draftClassId }, include: { calendarEntry: true } });
    expect(Number(cls.targetRate)).toBe(24.5); // untouched
  });

  test("another teacher's session is redirected away from the editor", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await context.addCookies([sessionCookie(otherTeacherToken)]);
    await page.goto(`/class/${draftClassId}/edit`);
    await page.waitForURL((url) => url.pathname === '/schedule', { timeout: 10_000 });
  });

  test('a locked class disables economics but still saves details', async ({ page }) => {
    await page.goto(`/class/${lockedClassId}/edit`);

    await expect(page.getByText(/Locked since the first registration/)).toBeVisible();
    await expect(page.getByLabel('Target rate (€)')).toBeDisabled();
    await expect(page.getByLabel('Max students')).toBeDisabled();

    await page.getByLabel('Description').fill('Bring your own mat.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    const cls = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId }, include: { calendarEntry: true } });
    expect(cls.description).toBe('Bring your own mat.');
    expect(Number(cls.targetRate)).toBe(20); // untouched
    // The unchanged date round-trips exactly — a local-time prefill
    // refactor would shift this a day for west-of-UTC teachers.
    expect(cls.calendarEntry.date.toISOString().slice(0, 10)).toBe('2099-07-08');
  });

  test('terminal stages have no editor', async ({ page }) => {
    await page.goto(`/class/${cancelledClassId}/edit`);
    await page.waitForURL(`**/class/${cancelledClassId}`);
    await expect(page.getByText('This class was cancelled.')).toBeVisible();
    // And no link invites the dead end.
    await expect(page.getByRole('link', { name: 'Edit class' })).toHaveCount(0);
  });
});

import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

const prisma = new PrismaClient();

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const teacherToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let otherTeacherId: string;
const otherTeacherToken = crypto.randomBytes(32).toString('hex');
let roomId: string;
let draftClassId: string;
let lockedClassId: string;
let cancelledClassId: string;
let studentId: string;

test.describe('Class edit screen', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Editing',
        lastName: 'Teacher',
        email: `e2e-classedit-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `e2e-classedit-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Class edit e2e',
        pageSlug: `e2e-classedit-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    await prisma.session.create({
      data: {
        id: hashToken(teacherToken),
        accountId: teacher.accountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `e2e-classedit-other-${uniqueSuffix}@test.local`,
        account: { create: { email: `e2e-classedit-other-${uniqueSuffix}@test.local` } },
        bio: 'Ownership fixture',
        pageSlug: `e2e-classedit-other-${uniqueSuffix}`,
      },
    });
    otherTeacherId = other.id;
    await prisma.session.create({
      data: {
        id: hashToken(otherTeacherToken),
        accountId: other.accountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const room = await prisma.room.create({
      data: {
        venueName: 'Edit Studio',
        address: `${uniqueSuffix} Edit St`,
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

    async function mkClass(status: 'draft' | 'open' | 'cancelled', locked: boolean, day: string) {
      return prisma.class.create({
        data: {
          teacherId,
          teacherRoomId: teacherRoom.id,
          classType: 'Editable Hatha',
          date: new Date(day),
          startTime: '10:00',
          durationMinutes: 60,
          roomCost: 30,
          minRate: 12,
          targetRate: 20,
          minStudents: 2,
          maxStudents: 10,
          status,
          settingsLocked: locked,
        },
      });
    }
    draftClassId = (await mkClass('draft', false, '2099-07-01')).id;
    lockedClassId = (await mkClass('open', true, '2099-07-08')).id;
    cancelledClassId = (await mkClass('cancelled', false, '2099-07-15')).id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Locked',
        lastName: 'Student',
        email: `e2e-classedit-student-${uniqueSuffix}@test.local`,
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
    const classIds = [draftClassId, lockedClassId, cancelledClassId].filter(Boolean);
    if (classIds.length) {
      await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
      await prisma.class.deleteMany({ where: { id: { in: classIds } } });
    }
    if (teacherId) await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (studentId) await prisma.student.delete({ where: { id: studentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${uniqueSuffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: 'fair_yoga_session', value: teacherToken, url: 'http://localhost:3000' },
    ]);
  });

  test('a draft edits fully — details and economics', async ({ page }) => {
    await page.goto(`/class/${draftClassId}`);
    await page.getByRole('link', { name: 'Edit class' }).click();
    await page.waitForURL(`**/class/${draftClassId}/edit`);

    await page.getByLabel('Class type').fill('Morning Hatha');
    await page.getByLabel('Target rate (€)').fill('24');
    // The date field is the one whose route conversion this PR fixed —
    // change it explicitly so the round trip is canonical coverage.
    await page.getByLabel('Date').fill('2099-07-02');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    const cls = await prisma.class.findUniqueOrThrow({ where: { id: draftClassId } });
    expect(cls.classType).toBe('Morning Hatha');
    expect(Number(cls.targetRate)).toBe(24);
    expect(cls.date.toISOString().slice(0, 10)).toBe('2099-07-02');
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
    await expect(page.getByText(/Cannot update economic fields/)).toBeVisible();

    const cls = await prisma.class.findUniqueOrThrow({ where: { id: draftClassId } });
    expect(Number(cls.targetRate)).toBe(24); // untouched
  });

  test("another teacher's session is redirected away from the editor", async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await context.addCookies([
      { name: 'fair_yoga_session', value: otherTeacherToken, url: 'http://localhost:3000' },
    ]);
    await page.goto(`/class/${draftClassId}/edit`);
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
  });

  test('a locked class disables economics but still saves details', async ({ page }) => {
    await page.goto(`/class/${lockedClassId}/edit`);

    await expect(page.getByText(/Locked since the first registration/)).toBeVisible();
    await expect(page.getByLabel('Target rate (€)')).toBeDisabled();
    await expect(page.getByLabel('Max students')).toBeDisabled();

    await page.getByLabel('Description').fill('Bring your own mat.');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    const cls = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
    expect(cls.description).toBe('Bring your own mat.');
    expect(Number(cls.targetRate)).toBe(20); // untouched
    // The unchanged date round-trips exactly — a local-time prefill
    // refactor would shift this a day for west-of-UTC teachers.
    expect(cls.date.toISOString().slice(0, 10)).toBe('2099-07-08');
  });

  test('terminal stages have no editor', async ({ page }) => {
    await page.goto(`/class/${cancelledClassId}/edit`);
    await page.waitForURL(`**/class/${cancelledClassId}`);
    await expect(page.getByText('This class was cancelled.')).toBeVisible();
    // And no link invites the dead end.
    await expect(page.getByRole('link', { name: 'Edit class' })).toHaveCount(0);
  });
});

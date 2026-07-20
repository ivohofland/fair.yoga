import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

/**
 * The passkey journey, on a real (virtual) authenticator: a student adds
 * a passkey from the account page, signs out, and signs back in from a
 * teacher's booking page — landing back on the class they were booking,
 * not on a generic default.
 *
 * One long test on purpose: the virtual authenticator (and the private
 * key it holds) lives in the per-test browser context. Split into
 * sibling tests, the second one gets a fresh context with no credential
 * and fails confusingly.
 */

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const slug = `e2e-passkey-${uniqueSuffix}`;
const studentToken = crypto.randomBytes(32).toString('hex');

let teacherId: string;
let roomId: string;
let classId: string;
let studentId: string;

test.describe('Passkey sign-in', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Passkey',
        lastName: 'Teacher',
        email: `e2e-passkey-teacher-${uniqueSuffix}@test.local`,
        bio: 'Passkey e2e fixtures',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Passkey Studio',
        address: `${uniqueSuffix} Passkey St`,
        city: 'Amsterdam',
        postcode: '1234PK',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 25 },
    });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 7);
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Passkey Vinyasa',
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

    const student = await prisma.student.create({
      data: {
        firstName: 'Pass',
        lastName: 'Key',
        email: `e2e-passkey-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;
    await prisma.session.create({
      data: {
        id: hashToken(studentToken),
        userId: studentId,
        userType: 'student',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  test.afterAll(async () => {
    // Guarded per id: after a partial beforeAll an unset id must skip its
    // deletes — an `undefined` in a deleteMany filter matches everything.
    if (studentId) {
      await prisma.passkeyCredential.deleteMany({ where: { userId: studentId } });
      await prisma.session.deleteMany({ where: { userId: studentId } });
    }
    if (teacherId) {
      await prisma.class.deleteMany({ where: { teacherId } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    }
    await prisma.room.deleteMany({ where: { address: { contains: uniqueSuffix } } });
    await prisma.student.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    await prisma.teacher.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    await prisma.$disconnect();
  });

  test('student adds a passkey, then signs in from the booking page and lands back on the class', async ({
    page,
    context,
  }) => {
    // Virtual authenticator: resident key (required — sign-in happens
    // without typing an email, so no allowCredentials narrowing), user
    // verified, no prompts.
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });

    // Signed in (session cookie), the student enrols a passkey.
    await context.addCookies([
      { name: 'fair_yoga_session', value: studentToken, url: 'http://localhost:3000' },
    ]);
    await page.goto('/account');
    await page.getByRole('button', { name: 'Add a passkey' }).click();
    await expect(page.getByText(/Passkey added/)).toBeVisible();
    expect(await prisma.passkeyCredential.count({ where: { userId: studentId } })).toBe(1);

    // Signed out again, they open the booking page for a class.
    await context.clearCookies();
    await page.goto(`/${slug}/book/${classId}`);
    await expect(page.getByText('First time here?')).toBeVisible();
    // First-timers can't have a passkey — no button on the new-account path.
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0);

    // The returning-account path offers the passkey next to the email link.
    await page.getByRole('button', { name: 'Already have an account?' }).click();
    await expect(page.getByText('Welcome back')).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

    // Signed in and back on the same class — tier selection, not /bookings.
    await expect(page.getByText('Your tier')).toBeVisible({ timeout: 10_000 });
    expect(new URL(page.url()).pathname).toBe(`/${slug}/book/${classId}`);

    // Same passkey from /login, which passes no redirect: the role default
    // applies and the student lands on their bookings.
    await context.clearCookies();
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await page.waitForURL('**/bookings', { timeout: 10_000 });
  });
});

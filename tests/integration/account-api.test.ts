import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/**
 * The account-scoped routes on a teacher account that becomes dual:
 * joining as a student (including claiming an unclaimed CRM row with the
 * same email), the double-join 409, the dual export shape, and the dual
 * notifications feed.
 */

const email = `accapi-teacher-${suffix}@test.local`;

let accountId: string;
let teacherId: string;
let unclaimedStudentId: string;
let rawToken: string;

const authed = (path: string, init?: RequestInit) =>
  fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...init?.headers, ...cookie(rawToken) },
  });

beforeAll(async () => {
  await prisma.$connect();
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'AccApi',
      lastName: 'Teacher',
      email,
      bio: 'Account API fixtures',
      pageSlug: `accapi-${suffix}`,
      account: { create: { email } },
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  rawToken = await seedSession(prisma, accountId);

  // The teacher already sits in someone's CRM as an unclaimed contact
  // under the same email — the join must claim this row, not collide.
  const unclaimed = await prisma.student.create({
    data: { firstName: 'Crm', lastName: 'Ghost', email },
  });
  unclaimedStudentId = unclaimed.id;
});

afterAll(async () => {
  await prisma.notification.deleteMany({
    where: { recipientId: { in: [teacherId, unclaimedStudentId] } },
  });
  await prisma.session.deleteMany({ where: { accountId } });
  await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('POST /api/account/student-profile', () => {
  it('rejects when signed out', async () => {
    const res = await fetch(`${BASE_URL}/api/account/student-profile`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('claims the unclaimed CRM row with the account email instead of creating a duplicate', async () => {
    const res = await authed('/api/account/student-profile', { method: 'POST' });

    expect(res.status).toBe(201);
    const student = await prisma.student.findUniqueOrThrow({
      where: { id: unclaimedStudentId },
    });
    expect(student.accountId).toBe(accountId);
    expect(student.claimedAt).not.toBeNull();
    // No second Student row for this email.
    expect(await prisma.student.count({ where: { email } })).toBe(1);
  });

  it('rejects a second join with a machine-readable 409', async () => {
    const res = await authed('/api/account/student-profile', { method: 'POST' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code?: string } };
    expect(body.error.code).toBe('ALREADY_STUDENT');
  });
});

describe('GET /api/account/export — dual account', () => {
  it('returns both sides under their own keys', async () => {
    const res = await authed('/api/account/export');

    expect(res.status).toBe(200);
    // The export is a raw JSON download (attachment), not a {data} envelope.
    const body = (await res.json()) as { teacher?: unknown; student?: unknown };
    expect(body.teacher).toBeDefined();
    expect(body.student).toBeDefined();
  });
});

describe('GET /api/notifications — dual account', () => {
  it('returns both profiles’ notifications with a combined total', async () => {
    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'Teacher-side note',
        body: 'For the teaching hat.',
      },
    });
    await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: unclaimedStudentId,
        type: 'booking_confirmed',
        title: 'Student-side note',
        body: 'For the student hat.',
      },
    });

    const res = await authed('/api/notifications');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { notifications: Array<{ title: string }>; total: number };
    };
    const titles = body.data.notifications.map((n) => n.title);
    expect(titles).toContain('Teacher-side note');
    expect(titles).toContain('Student-side note');
    expect(body.data.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/account
// ---------------------------------------------------------------------------

/**
 * Erasure destroys the account it runs on, so these cannot share the module
 * fixture above — each test seeds its own and the block cleans up after all
 * of them.
 *
 * `gdpr.test.ts` already pins what erasure *means* (anonymise, keep financial
 * rows, cancel-and-notify, scrub the account email with the last live
 * profile). What it structurally cannot reach is the route's orchestration of
 * the two service calls — which is the half that can leave a real person
 * partly erased. That is what this block covers.
 */
describe('DELETE /api/account', () => {
  // Tracked by id, never by email: erasure anonymises the email, so an
  // `email contains suffix` filter silently stops matching exactly the rows
  // these tests create — and the teardown then fails on a foreign key,
  // poisoning every later run of this suite.
  const seededAccountIds: string[] = [];
  const seededTeacherIds: string[] = [];
  const seededStudentIds: string[] = [];
  const seededRoomIds: string[] = [];
  const seededTeacherRoomIds: string[] = [];
  const seededClassIds: string[] = [];

  /** A dual-role account: one Account carrying both a Teacher and a Student. */
  const seedDual = async (label: string) => {
    const mail = `accdel-${label}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Del',
        lastName: label,
        email: mail,
        bio: 'DELETE /api/account fixtures',
        pageSlug: `accdel-${label}-${suffix}`,
        account: { create: { email: mail } },
      },
    });
    const student = await prisma.student.create({
      data: {
        firstName: 'Del',
        lastName: label,
        email: `student-${mail}`,
        accountId: teacher.accountId,
        claimedAt: new Date(),
      },
    });
    seededAccountIds.push(teacher.accountId);
    seededTeacherIds.push(teacher.id);
    seededStudentIds.push(student.id);
    return {
      accountId: teacher.accountId,
      teacherId: teacher.id,
      studentId: student.id,
      token: await seedSession(prisma, teacher.accountId),
    };
  };

  afterAll(async () => {
    // Erasure soft-deletes, so every row these tests made is still here, and
    // dependants must go before their parents.
    await prisma.payment.deleteMany({
      where: { registration: { classId: { in: seededClassIds } } },
    });
    await prisma.registration.deleteMany({ where: { classId: { in: seededClassIds } } });
    await prisma.notification.deleteMany({
      where: {
        OR: [
          { relatedClassId: { in: seededClassIds } },
          { recipientId: { in: [...seededTeacherIds, ...seededStudentIds] } },
        ],
      },
    });
    await prisma.class.deleteMany({ where: { id: { in: seededClassIds } } });
    await prisma.teacherRoom.deleteMany({ where: { id: { in: seededTeacherRoomIds } } });
    await prisma.room.deleteMany({ where: { id: { in: seededRoomIds } } });
    await prisma.student.deleteMany({ where: { id: { in: seededStudentIds } } });
    await prisma.teacher.deleteMany({ where: { id: { in: seededTeacherIds } } });
    await prisma.session.deleteMany({ where: { accountId: { in: seededAccountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: seededAccountIds } } });
  });

  it('rejects an unauthenticated delete', async () => {
    const res = await fetch(`${BASE_URL}/api/account`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('erases both halves of a dual account and invalidates the session', async () => {
    const acc = await seedDual('happy');

    const res = await fetch(`${BASE_URL}/api/account`, {
      method: 'DELETE',
      headers: cookie(acc.token),
    });
    expect(res.status).toBe(200);

    // The service tests assert the composed order; this asserts the ROUTE
    // composes it — both profiles gone in one request, not just the first.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: acc.teacherId } });
    const student = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
    expect(teacher.deletedAt).not.toBeNull();
    expect(student.deletedAt).not.toBeNull();

    // Last live profile erased: the account email is PII too, and the
    // session must not outlive the profiles it authenticated.
    const account = await prisma.account.findUniqueOrThrow({ where: { id: acc.accountId } });
    expect(account.email).toBe(`deleted-${acc.accountId}@deleted.invalid`);
    expect(await prisma.session.count({ where: { accountId: acc.accountId } })).toBe(0);
  });

  it('reports PARTIAL_ERASURE when the teacher half fails after the student half committed, and a retry finishes the job', async () => {
    const acc = await seedDual('partial');

    // Make the teacher half throw, using real data rather than a mock: the
    // route's erasure of a teacher completes their in-progress classes first
    // (gdpr.ts, uncaught), and `completeClass` creates one Payment per charged
    // registration inside its transaction. `Payment.registrationId` is @unique,
    // so a Payment that already exists makes that create throw P2002.
    //
    // It has to throw rather than return a failure: `deleteTeacherAccount`
    // (`gdpr.ts`) catches `{ok: false}` from `completeClass` and falls
    // through, so a merely-failing completion would not produce
    // PARTIAL_ERASURE at all.
    //
    // This injection replaced `tierAtBooking: 0` when #39 added a CHECK
    // constraint making that value unwritable. Same three properties: real
    // data, uncaught, and reversible so the retry can succeed.
    const room = await prisma.room.create({
      data: {
        venueName: 'Erasure Venue',
        address: `${suffix} Erasure St`,
        city: 'Testville',
        postcode: '1234ER',
        floor: '1',
        roomName: 'Hall',
        maxCapacity: 10,
        createdById: acc.teacherId,
      },
    });
    seededRoomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: acc.teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    seededTeacherRoomIds.push(teacherRoom.id);
    const cls = await prisma.class.create({
      data: {
        teacherId: acc.teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Erasure Flow',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'in_progress',
      },
    });
    seededClassIds.push(cls.id);
    const attendee = await prisma.student.create({
      data: { firstName: 'Book', lastName: 'Ed', email: `attendee-${suffix}@test.local` },
    });
    seededStudentIds.push(attendee.id);
    const registration = await prisma.registration.create({
      data: { classId: cls.id, studentId: attendee.id, tierAtBooking: 3 },
    });
    // The row that makes completeClass's payment.create collide.
    const blockingPayment = await prisma.payment.create({
      data: { registrationId: registration.id, amount: 1, status: 'pending' },
    });

    const del = () =>
      fetch(`${BASE_URL}/api/account`, { method: 'DELETE', headers: cookie(acc.token) });

    const first = await del();
    expect(first.status).toBe(500);
    const body = (await first.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('PARTIAL_ERASURE');

    // The advice in that message ("Press Delete again to finish") is only
    // sound if the student half really did commit — otherwise the user is
    // being told to finish something that never started.
    const student = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
    expect(student.deletedAt).not.toBeNull();
    const teacherAfterFirst = await prisma.teacher.findUniqueOrThrow({
      where: { id: acc.teacherId },
    });
    expect(teacherAfterFirst.deletedAt).toBeNull();

    // And the retry has to be able to authenticate: the session survives
    // because a live teacher profile still uses the account.
    expect(await prisma.session.count({ where: { accountId: acc.accountId } })).toBe(1);

    // Clear the failure and press Delete again, as the message instructs.
    await prisma.payment.delete({ where: { id: blockingPayment.id } });

    const second = await del();
    expect(second.status).toBe(200);

    const teacherAfterRetry = await prisma.teacher.findUniqueOrThrow({
      where: { id: acc.teacherId },
    });
    expect(teacherAfterRetry.deletedAt).not.toBeNull();
    const account = await prisma.account.findUniqueOrThrow({ where: { id: acc.accountId } });
    expect(account.email).toBe(`deleted-${acc.accountId}@deleted.invalid`);
  });
});

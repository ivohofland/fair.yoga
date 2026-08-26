import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

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

  /** A teacher-only account: one Account carrying a Teacher and no Student. */
  const seedTeacherOnly = async (label: string) => {
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
    seededAccountIds.push(teacher.accountId);
    seededTeacherIds.push(teacher.id);
    return {
      accountId: teacher.accountId,
      teacherId: teacher.id,
      token: await seedSession(prisma, teacher.accountId),
    };
  };

  /**
   * An in-progress class with one charged registration, for the teacher-only
   * erasure test below. `deleteTeacherAccount` completes every in-progress
   * class it finds BEFORE opening its own transaction, so this is a
   * separately committed unit of work — which is the whole point of the test.
   * Dated 2099 so the dev server's own `autoCompleteClasses` sweep, which
   * only completes a class past its end time, cannot be what completed it.
   */
  const seedInProgressClass = async (teacherId: string, label: string) => {
    const room = await prisma.room.create({
      data: {
        venueName: `Venue ${label}`,
        address: `${suffix} ${label} St`,
        city: 'Testville',
        postcode: '1234TO',
        floor: '1',
        roomName: 'Hall',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    seededRoomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    seededTeacherRoomIds.push(teacherRoom.id);
    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: `Flow ${label}`,
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'in_progress',
      });
    seededClassIds.push(cls.id);
    const attendee = await prisma.student.create({
      data: { firstName: 'Att', lastName: label, email: `att-${label}-${suffix}@test.local` },
    });
    seededStudentIds.push(attendee.id);
    const registration = await prisma.registration.create({
      data: { classId: cls.id, studentId: attendee.id, tierAtBooking: 3 },
    });
    return { classId: cls.id, registrationId: registration.id };
  };

  /**
   * A student-only account: one Account carrying a Student and no Teacher.
   * The dual seed above cannot stand in for it — the two failure paths below
   * are `deleteStudentAccount`'s own, and on a dual account a student-half
   * failure is indistinguishable in the response from a teacher-half one.
   */
  const seedStudentOnly = async (label: string) => {
    const mail = `accdel-${label}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Del',
        lastName: label,
        email: mail,
        claimedAt: new Date(),
        account: { create: { email: mail } },
      },
    });
    const studentAccountId = student.accountId as string;
    seededAccountIds.push(studentAccountId);
    seededStudentIds.push(student.id);
    return {
      accountId: studentAccountId,
      studentId: student.id,
      token: await seedSession(prisma, studentAccountId),
    };
  };

  afterAll(async () => {
    // Erasure soft-deletes, so every row these tests made is still here, and
    // dependants must go before their parents.
    await prisma.waitlistEntry.deleteMany({ where: { classId: { in: seededClassIds } } });
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
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: seededClassIds } } } } });
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
    const cls = await createClassFixture(prisma, {
        teacherId: acc.teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Erasure Flow',
        date: new Date('2026-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'in_progress',
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

  /**
   * The `ERASURE_FAILED` half of the route's catch. Its `PARTIAL_ERASURE`
   * sibling above has been covered by injection since it landed; this branch
   * had zero coverage, which is how it kept the retry advice its wording no
   * longer justifies.
   *
   * Same three properties as that injection — real data, uncaught, reversible
   * — on a different collision. `deleteStudentAccount` rewrites the account
   * email to `deleted-<accountId>@deleted.invalid` when the last live profile
   * on it goes, and `Account.email` is `@unique`, so an Account already
   * holding that exact address makes the write throw `P2002`. Permanent, not
   * transient: retrying changes nothing until somebody removes the other row.
   *
   * What this pins is the discrimination, not just the code: `P2002` is not
   * in `isTransientDbError`'s set, so the answer must be a 500 that does NOT
   * tell the caller to press Delete again — the behaviour before #174's fix
   * wave, where every failure got the same "Press Delete again to finish."
   */
  it('reports ERASURE_FAILED, without retry advice, when the student half fails permanently', async () => {
    const acc = await seedStudentOnly('failed');

    const blocker = await prisma.account.create({
      data: { email: `deleted-${acc.accountId}@deleted.invalid` },
    });
    seededAccountIds.push(blocker.id);

    const del = () =>
      fetch(`${BASE_URL}/api/account`, { method: 'DELETE', headers: cookie(acc.token) });

    const first = await del();
    expect(first.status).toBe(500);
    const body = (await first.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('ERASURE_FAILED');
    // The assertion is on what the message TELLS them to do, not on whether
    // the word "again" appears — this message names the retry precisely in
    // order to rule it out ("pressing Delete again will not fix it"), which a
    // naive `not.toMatch(/again/)` would read as a failure.
    expect(body.error.message).toMatch(/will not fix it/i);
    expect(body.error.message).toMatch(/contact support/i);

    // "Nothing was changed" is a claim this message makes, and it may only
    // make it on the STUDENT half — `deleteStudentAccount` is one transaction
    // end to end, so a throw out of it rolls every write back including the
    // profile anonymisation. The teacher half is not, and must not say this;
    // the test below is the one that holds it to that.
    expect(body.error.message).toMatch(/Nothing was changed/i);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
    expect(student.deletedAt).toBeNull();
    expect(student.firstName).toBe('Del');
    expect(await prisma.session.count({ where: { accountId: acc.accountId } })).toBe(1);

    // And the failure really was the collision, not something incidental:
    // clear it and the identical request goes through.
    await prisma.account.delete({ where: { id: blocker.id } });
    const second = await del();
    expect(second.status).toBe(200);
    const after = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
    expect(after.deletedAt).not.toBeNull();
  }, 30_000);

  /**
   * The teacher-only path, and the one thing its message may NOT say.
   *
   * `deleteTeacherAccount` is not a single transaction: before `db
   * .$transaction` opens it runs `completeClass(db, cls.id, { finishedEarly: true })` for every
   * in-progress class, and each of those commits on its own — pricing the
   * class, writing a `Payment` per charged registration, sending
   * notifications. So a failure after that loop leaves real, irreversible
   * billing behind, and the first version of this fix wave answered it with
   * "Nothing was changed", which is a lie about money.
   *
   * One in-progress class, which completes and commits, and the failure
   * injected AFTER the loop — the same `Account.email` collision the
   * ERASURE_FAILED test above uses, which `deleteTeacherAccount` hits inside
   * its own transaction. Nothing here depends on which row an unordered read
   * returns first.
   */
  it('does not claim nothing changed when the teacher erasure already billed a class', async () => {
    const acc = await seedTeacherOnly('teacheronly');
    const billed = await seedInProgressClass(acc.teacherId, 'billed');

    const blocker = await prisma.account.create({
      data: { email: `deleted-${acc.accountId}@deleted.invalid` },
    });
    seededAccountIds.push(blocker.id);

    const res = await fetch(`${BASE_URL}/api/account`, {
      method: 'DELETE',
      headers: cookie(acc.token),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('ERASURE_FAILED');

    // The load-bearing assertion: this message must not tell a teacher that
    // nothing changed, because something did.
    expect(body.error.message).not.toMatch(/Nothing was changed/i);
    expect(body.error.message).toMatch(/closed and billed/i);

    // And something really did — the class completed, in its own committed
    // transaction, before the failure.
    const completed = await prisma.class.findUniqueOrThrow({ where: { id: billed.classId }, include: { calendarEntry: true },});
    expect(completed.status).toBe('completed');
    expect(
      await prisma.payment.count({ where: { registrationId: billed.registrationId } }),
    ).toBe(1);

    // The teacher is still there — the erasure itself did not land.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: acc.teacherId } });
    expect(teacher.deletedAt).toBeNull();
  }, 30_000);

  /**
   * The other side of the same discrimination, and the one the branch made
   * reachable: a lost lock race is a 503 that DOES tell the caller to try
   * again, because the next attempt can win.
   *
   * Provoked with the real mechanism rather than a mock — this test holds the
   * `Class` row that `deleteStudentAccount`'s own `lockClassRow` loop must
   * take (the student is `waiting` in that class), for longer than the 2s
   * `SET LOCAL lock_timeout` that loop sets. Postgres cancels the erasure's
   * `FOR UPDATE` with `55P03`, the whole transaction rolls back, and the
   * route has to recognise it as contention rather than a defect.
   */
  it('reports ERASURE_BUSY with retry advice when the erasure loses a lock race', async () => {
    const acc = await seedStudentOnly('busy');

    const room = await prisma.room.create({
      data: {
        venueName: 'Busy Venue',
        address: `${suffix} Busy St`,
        city: 'Testville',
        postcode: '1234BU',
        floor: '1',
        roomName: 'Hall',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    seededRoomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    seededTeacherRoomIds.push(teacherRoom.id);
    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Busy Flow',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: 'open',
      });
    seededClassIds.push(cls.id);
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: acc.studentId, position: 1, status: 'waiting' },
    });

    // Held for 4s — comfortably past the erasure's own 2s bound, so what this
    // observes is the timeout and not merely a wait.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
        await new Promise((r) => setTimeout(r, 4_000));
      },
      { timeout: 20_000 },
    );
    await new Promise((r) => setTimeout(r, 200));

    try {
      const res = await fetch(`${BASE_URL}/api/account`, {
        method: 'DELETE',
        headers: cookie(acc.token),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { message: string; code?: string } };
      expect(body.error.code).toBe('ERASURE_BUSY');
      expect(body.error.message).toMatch(/again/i);

      const student = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
      expect(student.deletedAt).toBeNull();
    } finally {
      await holder;
    }

    // The retry the message promises actually works once the contention is
    // gone — which is the difference from ERASURE_FAILED above.
    const second = await fetch(`${BASE_URL}/api/account`, {
      method: 'DELETE',
      headers: cookie(acc.token),
    });
    expect(second.status).toBe(200);
  }, 40_000);

  /**
   * #196 branch 2, Task 3, route half. The service now aborts a redundant
   * erasure with `AlreadyErasedError` so its post-commit `handleSpotFreed`
   * loop cannot broadcast twice (`gdpr.test.ts` owns that assertion). This
   * pins the other half of that decision: the loser's abort is a SUCCESS, and
   * must not fall into `erasureFailure` — which would answer a 500 and tell a
   * user their account could not be removed, about an account that is gone.
   *
   * The lever is the one Tasks 1 and 2 established, for the reason they
   * recorded: two plain fetches serialise, and a serialised second request
   * never reaches the guard at all — `validateSession` resolves only live
   * profiles, so it would 401 before the route ran. The holder takes the
   * `Student` row that ends the erasure transaction, so both requests
   * authenticate against a live profile, both run their whole transaction,
   * and both park at the write — the interleaving `Promise.all` alone cannot
   * force. Held well inside the erasure's own 2s `lock_timeout`, so what the
   * loser meets is the CAS and not `55P03`.
   */
  it('answers both halves of a concurrent erasure with success', async () => {
    const acc = await seedStudentOnly('concurrent');

    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    // A handshake rather than a fixed sleep: `$transaction` returns before its
    // callback has run, so a timed guess is a race of its own — and one that
    // fails silently, by letting both requests through before the lock exists.
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${acc.studentId} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await parked;

    const del = () =>
      fetch(`${BASE_URL}/api/account`, { method: 'DELETE', headers: cookie(acc.token) });
    const both = Promise.all([del(), del()]);

    // 700ms, not the second the other race tests hold: `deleteStudentAccount`
    // opens with `setLockTimeout`, so a request parked longer than 2s is
    // cancelled with `55P03` and takes the 503 ERASURE_BUSY path instead of
    // the CAS. The loser waits this hold PLUS the winner's remaining
    // statements, so the margin is smaller than it looks.
    let settled = false;
    void both.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 700));

    // The lever is asserted, not assumed: a request answered before the
    // release never reached the CAS, and a serialised second request would
    // have 401'd (`validateSession` resolves only live profiles) rather than
    // exercising anything this test is about.
    expect(settled).toBe(false);
    release();
    await holding;
    const [a, b] = await both;

    // Both are honest: the account is gone either way, so neither caller is
    // told it failed. A 500 here is the defect — a successful outcome
    // reported as an error — and this is the assertion that names it.
    expect([a.status, b.status]).toEqual([200, 200]);

    const student = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
    expect(student.deletedAt).not.toBeNull();
    // The winner's transaction is what cleared the session; the loser rolled
    // back whole and left it alone.
    expect(await prisma.session.count({ where: { accountId: acc.accountId } })).toBe(0);
  }, 40_000);

  /**
   * The DUAL-role shape of the same race, and the one the route's own comment
   * asserts in prose ("Caught per half so a dual-role account whose student
   * half is already erased still goes on to erase its teacher half below")
   * with nothing holding it to it. The student-only case above cannot reach
   * it: with no teacher profile there is no second half to go on to.
   *
   * It is also the one shape where the `partial` flag can produce a
   * materially false message. The loser's student half throws
   * `AlreadyErasedError` and rolls back whole, yet `session.studentId` stays
   * truthy — so `partial = Boolean(session.studentId)` is true for it. If the
   * teacher half's sentinel were not caught, that loser would be answered
   * with a 500 reading "Your student data was removed … Removing the rest of
   * your teaching data failed. Pressing Delete again will not fix it —
   * please contact support," about an account both halves of which are gone.
   * A teacher sent to support over a completed deletion.
   *
   * ONE request, not two, and that is the whole design of this test. An
   * earlier version raced two deletes and asserted the teacher was erased —
   * which the WINNER does, so a `return` on the loser's student-half sentinel
   * changed nothing observable and the test could not fail against the
   * mutation its own comment named. Here the holder erases the student half
   * itself and never touches the `Teacher`, so the single request under test
   * is the only thing in the world that can set `teacher.deletedAt`. If its
   * student half stops falling through, the teacher stays live and the first
   * assertion says so.
   *
   * The session is resolved before the holder commits, so `session.studentId`
   * is truthy for a profile that is erased by the time the CAS re-evaluates —
   * which is exactly the state the concurrent case produces, without needing
   * two racers to land in the right order.
   */
  it('finishes the teacher half when the student half was erased underneath it', async () => {
    const acc = await seedDual('dualrace');

    let release!: () => void;
    let locked!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const parked = new Promise<void>((r) => { locked = r; });
    const holding = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${acc.studentId} FOR UPDATE`;
        locked();
        await released;
        // The other request's erasure of the student half, committing while
        // this one is parked on the row. Only the Student — the Teacher is
        // left for the request under test, so it alone can erase it.
        await tx.student.update({
          where: { id: acc.studentId },
          data: { deletedAt: new Date(), email: `deleted-${acc.studentId}@deleted.invalid` },
        });
      },
      { timeout: 20_000 },
    );
    await parked;

    const deleting = fetch(`${BASE_URL}/api/account`, {
      method: 'DELETE',
      headers: cookie(acc.token),
    });

    let settled = false;
    void deleting.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 700));
    expect(settled).toBe(false);
    release();
    await holding;
    const res = await deleting;

    // Asserted first, and it is the assertion the fall-through owns: nothing
    // but this request has written `Teacher`, so a `return` on the student
    // half's sentinel leaves a live teacher profile on an account whose owner
    // was told it was deleted.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: acc.teacherId } });
    expect(teacher.deletedAt).not.toBeNull();
    const student = await prisma.student.findUniqueOrThrow({ where: { id: acc.studentId } });
    expect(student.deletedAt).not.toBeNull();

    // And it is not told its deletion failed. Without the student half's
    // catch this is a 500 PARTIAL_ERASURE — "Your student data was removed …
    // Removing the rest of your teaching data failed … please contact
    // support" — about an account both halves of which are gone. `partial` is
    // `Boolean(session.studentId)`, which stays truthy for a half that rolled
    // back, so that message is reachable precisely here.
    expect(res.status).toBe(200);

    // Last live profile erased, so the account email is scrubbed and the
    // session is gone — the state the false message would have denied.
    const account = await prisma.account.findUniqueOrThrow({ where: { id: acc.accountId } });
    expect(account.email).toBe(`deleted-${acc.accountId}@deleted.invalid`);
    expect(await prisma.session.count({ where: { accountId: acc.accountId } })).toBe(0);
  }, 40_000);
});

import { describe, it, expect, beforeAll, afterAll, vi, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma, PrismaClient } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';
import { createClassFixture } from '../../../../tests/class-fixtures';
import { inviteContact } from '@/services/invitations';
import { prisma as appPrisma } from '@/lib/db';
import { log } from '@/lib/log';
import { POST } from './route';
import * as waitlistService from '@/services/waitlist';
import * as rateLimit from '@/lib/rate-limit';
import { erasedAddress } from '@/lib/erased-address';
import { hhmmToTime } from '@/lib/time-of-day';
import { expectRefusal, expectUnchanged } from '../../../../tests/api-assertions';

/**
 * What this route hands `resolveInvitationOnLink` (#418), pinned where it can
 * actually run.
 *
 * The rule itself — a booking returns a `pending` invitation to `accepted`
 * only when that same act created the roster link — belongs to
 * `services/link-consent.ts`, and `link-consent.test.ts` drives every cell of
 * it directly. What no test of that function can see is whether THIS handler
 * passes `linkTeacherStudent`'s own answer through or a literal: hardcode
 * `linkOutcome: 'created'` at the call site and every one of those cases stays
 * green while the oracle #418 closed reopens. `addToWaitlist`'s twin of this
 * wiring is pinned in `waitlist.test.ts`; this side had only
 * `tests/integration/registrations-api.test.ts`, which drives the app on
 * `:3000` and so cannot run in a worktree with no dev server on that port
 * (`BASE_URL`'s own docblock in `tests/helpers.ts` covers the override).
 *
 * The `POST` handler is invoked DIRECTLY, the way `api/classes/route.test.ts`
 * established: `NextRequest` is a plain Web-standard-based class Next.js
 * exports, and `getSessionToken` (`src/lib/auth/session.ts`) reads the session
 * off the request's own cookie jar rather than the request-scoped `cookies()`
 * helper from `next/headers` — so the real handler, its session check, its
 * transaction and its link write all run against the real test database with
 * no server anywhere.
 *
 * The integration test over this same route stays where it is: it exercises
 * the HTTP stack this file skips, and CI is where its verdict comes from.
 */
const prisma = new PrismaClient();
const suffix = uniqueSuffix();

describe('POST /api/registrations — resolveInvitationOnLink wiring (#418)', () => {
  let teacherId: string;
  let studentId: string;
  let classId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentEmail: string;
  let token: string;
  // The `linkOutcome: 'created'` half of the pair below: a student the teacher
  // has invited but never linked. `unlinked` distinguishes this fixture from
  // `studentId`/`studentEmail`/`token` above, which stay CLAIMED and LINKED
  // for the decoy-probe case.
  let unlinkedStudentId: string;
  let unlinkedStudentEmail: string;
  let unlinkedToken: string;
  // The `declined` half, which turns on nothing: already on the roster, and
  // behind a live `TeacherBlock`.
  let blockedStudentId: string;
  let blockedStudentEmail: string;
  let blockedToken: string;
  const accountIds: string[] = [];
  // A fixed instant so the reopening is measurable: `respondedAt` moving off
  // this value is what says the row was written again, which a bare
  // `not.toBeNull()` on an already-answered row cannot see.
  const declinedAt = new Date('2026-02-03T04:05:06.000Z');

  beforeAll(async () => {
    await prisma.$connect();

    const teacherEmail = `reg-route-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Reg', lastName: 'Route',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: '#418 registrations-route fixture teacher',
        pageSlug: `reg-route-${suffix}`,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Reg Route Studio', address: `${suffix} Reg St`, city: 'Amsterdam',
        postcode: '1234RR', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });
    teacherRoomId = teacherRoom.id;

    // 2099 so the class is unambiguously upcoming and open to a student
    // booking; nothing here reads the date or the time back.
    const cls = await createClassFixture(prisma, {
      teacherId, teacherRoomId,
      classType: 'Reg Route Vinyasa',
      date: new Date('2099-08-01'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 8,
      status: 'open',
    });
    classId = cls.id;

    // CLAIMED, LINKED, and sharing nothing — the exact state the gate falls
    // through for. Claimed because the booking below runs under this
    // student's own session, which needs their account. `shareEmail: false`
    // is written out rather than left to the default for the same reason
    // `link-consent.test.ts`'s `seedPair` writes it: the withheld address is
    // the precondition of the whole case.
    studentEmail = `reg-route-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Reg', lastName: 'Student',
        email: studentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: studentEmail } },
        teacherStudents: { create: { teacherId } },
        studentPrivacy: { create: { teacherId, shareEmail: false } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    // `Student.accountId` is nullable in the schema, and the session below
    // cannot be seeded without it — so this is a fixture assertion, not a
    // branch the test tolerates either way.
    const studentAccountId = student.accountId;
    if (!studentAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(studentAccountId);

    token = await seedSession(prisma, studentAccountId);

    // CLAIMED, NOT linked — the other half of the pair. A pending invitation
    // stands for this address, and nothing has put them on the roster yet, so
    // their own booking below is what should create the link AND resolve it.
    unlinkedStudentEmail = `reg-route-unlinked-${suffix}@test.local`;
    const unlinkedStudent = await prisma.student.create({
      data: {
        firstName: 'Reg', lastName: 'Unlinked',
        email: unlinkedStudentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: unlinkedStudentEmail } },
      },
      select: { id: true, accountId: true },
    });
    unlinkedStudentId = unlinkedStudent.id;
    const unlinkedAccountId = unlinkedStudent.accountId;
    if (!unlinkedAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(unlinkedAccountId);

    unlinkedToken = await seedSession(prisma, unlinkedAccountId);

    await prisma.invitation.create({
      data: {
        teacherId, email: unlinkedStudentEmail,
        firstName: 'Reg', lastName: 'Unlinked', status: 'pending',
      },
    });

    // CLAIMED, LINKED, declined, and blocked — the escape hatch's own shape.
    // A student who unlinked leaves both the tombstone and the block behind;
    // the link here is what a promotion racing that unlink restores
    // (`withdrawWaitingEntriesForTeacher`'s docblock, services/waitlist.ts),
    // and it is what makes this booking's own link write insert nothing.
    blockedStudentEmail = `reg-route-blocked-${suffix}@test.local`;
    const blockedStudent = await prisma.student.create({
      data: {
        firstName: 'Reg', lastName: 'Blocked',
        email: blockedStudentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: blockedStudentEmail } },
        teacherStudents: { create: { teacherId } },
      },
      select: { id: true, accountId: true },
    });
    blockedStudentId = blockedStudent.id;
    const blockedAccountId = blockedStudent.accountId;
    if (!blockedAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(blockedAccountId);

    blockedToken = await seedSession(prisma, blockedAccountId);

    await prisma.invitation.create({
      data: {
        teacherId, email: blockedStudentEmail,
        firstName: 'Reg', lastName: 'Blocked', status: 'declined', respondedAt: declinedAt,
      },
    });
    await prisma.teacherBlock.create({ data: { teacherId, email: blockedStudentEmail } });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({
      where: { id: { in: [studentId, unlinkedStudentId, blockedStudentId] } },
    });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    // Last, and after both profiles: `Student.accountId` and
    // `Teacher.accountId` are plain FKs with no cascade, so an account dropped
    // first is refused.
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  /**
   * The teacher probes an address they already hold — someone on their roster
   * who withheld it — and gets #417's ordinary, undelivered `pending` row.
   * The student then books, through their OWN session, so the handler takes
   * its `!isTeacher` branch and reaches the link write.
   *
   * Both halves are asserted because either one alone is satisfiable by a
   * failure: an untouched invitation is exactly what a booking that never
   * happened leaves behind.
   */
  it('leaves the decoy invitation pending, and still books the class', async () => {
    const probe = await inviteContact(prisma, {
      teacherId, email: studentEmail, firstName: 'Guessed', lastName: 'Address',
    });
    // Measured, not assumed: this is the fall-through the gate allows, not a
    // refusal. A fixture that met `ALREADY_LINKED` here would leave nothing
    // for the booking below to resolve, and the test would pass vacuously.
    if (!probe.ok) throw new Error(`expected the gated fall-through invite, got ${probe.reason}`);
    expect(probe.value.delivered).toBe(false);
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: studentEmail } },
        select: { status: true, respondedAt: true },
      }),
    ).toEqual({ status: 'pending', respondedAt: null });

    const request = new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ classId }),
    });
    const res = await POST(request);

    expect(res.status).toBe(201);
    const registration = await prisma.registration.findUnique({
      where: { classId_studentId: { classId, studentId } },
      select: { status: true },
    });
    expect(registration).toEqual({ status: 'registered' });

    // The handler's own wiring, and the only thing this file exists for: the
    // link already stood, so `linkTeacherStudent` inserted nothing, so the row
    // the teacher's next probe meets is the one their first probe left.
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: studentEmail } },
        select: { status: true, respondedAt: true },
      }),
    ).toEqual({ status: 'pending', respondedAt: null });
  });

  /**
   * The twin of the case above: same route, same wiring, opposite starting
   * link state. Here the student holds a `pending` invitation but is not yet
   * on the teacher's roster, so THIS booking is what creates the
   * `TeacherStudent` link — so the handler should hand
   * `resolveInvitationOnLink` a `linkOutcome` of `'created'`. Hardcode that
   * argument to `'already-linked'` (or drop the call to
   * `resolveInvitationOnLink` entirely) and this is the test that dies;
   * hardcode it to `'created'` and the test above does. Neither is provable
   * from one of them alone, which is why they are a pair.
   */
  it('creates the roster link and accepts the invitation for a first-time booker', async () => {
    expect(
      await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId: unlinkedStudentId } },
      }),
    ).toBeNull();
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: unlinkedStudentEmail } },
        select: { status: true, respondedAt: true },
      }),
    ).toEqual({ status: 'pending', respondedAt: null });

    const request = new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(unlinkedToken) },
      body: JSON.stringify({ classId }),
    });
    const res = await POST(request);

    expect(res.status).toBe(201);
    const registration = await prisma.registration.findUnique({
      where: { classId_studentId: { classId, studentId: unlinkedStudentId } },
      select: { status: true },
    });
    expect(registration).toEqual({ status: 'registered' });

    expect(
      await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId: unlinkedStudentId } },
      }),
    ).not.toBeNull();

    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: unlinkedStudentEmail } },
      select: { status: true, respondedAt: true },
    });
    expect(invitation.status).toBe('accepted');
    expect(invitation.respondedAt).not.toBeNull();
  });

  /**
   * The half of the rule that turns on nothing, pinned where the CALLER
   * decides whether to call at all. `link-consent.test.ts` proves that
   * `resolveInvitationOnLink` clears a `declined` row and its `TeacherBlock`
   * under an `'already-linked'` outcome — but it proves it from inside the
   * function, and nothing outside pinned that this route reaches the function
   * at all in that case. Wrap the call here in
   * `if (linkOutcome === 'created')` and every other test in this file, every
   * cell in `link-consent.test.ts`, and the whole unit tier stay green: this
   * is the one that dies. What it holds down is the escape hatch the decline
   * design rests on — book a class and you are back — for the one population
   * that needs it most, a student the teacher still has on their roster.
   *
   * `respondedAt` is compared against the seeded instant rather than
   * `not.toBeNull()`: this row was already answered, so it was never null and
   * a null check would pass on a write that never happened.
   */
  it('clears a declined tombstone and its block even though the link already stood', async () => {
    // The starting state is half the test. A booking that silently did
    // nothing would leave exactly this behind.
    expect(
      await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId: blockedStudentId } },
      }),
    ).not.toBeNull();
    expect(
      await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: blockedStudentEmail } },
        select: { status: true, respondedAt: true },
      }),
    ).toEqual({ status: 'declined', respondedAt: declinedAt });
    expect(
      await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email: blockedStudentEmail } },
      }),
    ).not.toBeNull();

    const request = new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(blockedToken) },
      body: JSON.stringify({ classId }),
    });
    const res = await POST(request);

    expect(res.status).toBe(201);

    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: blockedStudentEmail } },
      select: { status: true, respondedAt: true },
    });
    expect(invitation.status).toBe('accepted');
    expect(invitation.respondedAt).not.toEqual(declinedAt);

    expect(
      await prisma.teacherBlock.findUnique({
        where: { teacherId_email: { teacherId, email: blockedStudentEmail } },
      }),
    ).toBeNull();
  });
});

/**
 * The student's own booking writes `Student.tierSelectedAt` after its
 * transaction has committed, so by then the booking exists. A failure of that
 * write is answered as the booking's success, and logged: the booking holds,
 * and a retry would only be answered as unchanged.
 *
 * The spy is on the `@/lib/db` singleton the handler calls through, so the
 * failure is forced on the handler's own write; the booking's transaction
 * runs on its own transaction client and does not meet it.
 */
describe('POST /api/registrations — a failed tier-marker write after the booking committed', () => {
  let teacherId: string;
  let roomId: string;
  let classId: string;
  let studentId: string;
  let token: string;
  const accountIds: string[] = [];

  beforeAll(async () => {
    const teacherEmail = `reg-marker-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Reg', lastName: 'Marker',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'registrations-route marker-write fixture teacher',
        pageSlug: `reg-marker-${suffix}`,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Reg Marker Studio', address: `${suffix} Marker St`, city: 'Amsterdam',
        postcode: '1234RM', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });

    const cls = await createClassFixture(prisma, {
      teacherId, teacherRoomId: teacherRoom.id,
      classType: 'Reg Marker Vinyasa',
      date: new Date('2099-08-02'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 8,
      status: 'open',
    });
    classId = cls.id;

    const studentEmail = `reg-marker-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Reg', lastName: 'Marker',
        email: studentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    const studentAccountId = student.accountId;
    if (!studentAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(studentAccountId);
    token = await seedSession(prisma, studentAccountId);
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  // A plain `Error` is not a lost race, so the failure is logged at `error`,
  // with what identifies the booking it followed.
  it('answers 201 and logs the failure at error', async () => {
    const failure = new Error('forced tier-marker write failure');
    const markerWrite = vi.spyOn(appPrisma.student, 'updateMany').mockRejectedValueOnce(failure);
    onTestFinished(() => markerWrite.mockRestore());
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => warn.mockRestore());
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => error.mockRestore());

    const res = await POST(new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ classId }),
    }));

    // The forced failure was met, so the status below is about it.
    expect(markerWrite).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
    const registration = await prisma.registration.findUnique({
      where: { classId_studentId: { classId, studentId } },
      select: { id: true, status: true },
    });
    expect(registration?.status).toBe('registered');
    const message = 'booking committed but its tierSelectedAt write failed';
    expect(error).toHaveBeenCalledWith(
      {
        err: failure,
        studentId,
        classId,
        registrationId: registration?.id,
        transient: false,
        transientKind: null,
      },
      message,
    );
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), message);
  });

  /**
   * Two transient kinds, one message: `tx_budget` (`P2028`) logs at `warn` and
   * `pool_exhausted` (`P2024`) at `error` — `TRANSIENT_KIND_LEVEL`
   * (`lib/api-errors.ts`) is the authority, not a blanket "transient ⇒ warn".
   * Each case books its own student, since the fixture above already
   * consumed `studentId`'s one booking of `classId`.
   */
  it.each([
    { kind: 'tx_budget' as const, level: 'warn' as const, code: 'P2028' as const },
    { kind: 'pool_exhausted' as const, level: 'error' as const, code: 'P2024' as const },
  ])('answers 201 and logs a $kind failure at $level', async ({ kind, level, code }) => {
    const email = `reg-marker-${kind}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Reg', lastName: kind,
        email, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    const accountId = student.accountId;
    if (!accountId) throw new Error('fixture: the claimed student has no account');
    const markerToken = await seedSession(prisma, accountId);

    try {
      const failure = new Prisma.PrismaClientKnownRequestError('transient', {
        code,
        clientVersion: Prisma.prismaVersion.client,
      });
      const markerWrite = vi.spyOn(appPrisma.student, 'updateMany').mockRejectedValueOnce(failure);
      onTestFinished(() => markerWrite.mockRestore());
      const spy = vi.spyOn(log, level).mockImplementation(() => undefined as unknown as void);
      onTestFinished(() => spy.mockRestore());
      const otherLevel = level === 'warn' ? 'error' : 'warn';
      const other = vi.spyOn(log, otherLevel).mockImplementation(() => undefined as unknown as void);
      onTestFinished(() => other.mockRestore());

      const res = await POST(new NextRequest('http://localhost:3000/api/registrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(markerToken) },
        body: JSON.stringify({ classId }),
      }));

      expect(markerWrite).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(201);
      const registration = await prisma.registration.findUnique({
        where: { classId_studentId: { classId, studentId: student.id } },
        select: { id: true, status: true },
      });
      expect(registration?.status).toBe('registered');
      const message = 'booking committed but its tierSelectedAt write failed';
      expect(spy).toHaveBeenCalledWith(
        {
          err: failure,
          studentId: student.id,
          classId,
          registrationId: registration?.id,
          transient: true,
          transientKind: kind,
        },
        message,
      );
      expect(other).not.toHaveBeenCalledWith(expect.anything(), message);
    } finally {
      await prisma.registration.deleteMany({ where: { classId, studentId: student.id } });
      await prisma.session.deleteMany({ where: { accountId } });
      await prisma.student.deleteMany({ where: { id: student.id } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
  });
});

/**
 * A booking that already exists, found two ways: by the transaction's own
 * check, and by the unique key when a twin request committed first. The twin
 * is staged at `activateRegistration`, the write that would meet the key: the
 * stand-in reactivates the row on this file's own connection — the booking's
 * transaction holds no lock on it — and then raises the violation the real
 * insert would have raised.
 */
describe('POST /api/registrations — a booking that already exists', () => {
  let teacherId: string;
  let roomId: string;
  let classId: string;
  let studentId: string;
  let token: string;
  const accountIds: string[] = [];

  function book(): Promise<Response> {
    return POST(new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ classId }),
    }));
  }

  function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: Prisma.prismaVersion.client,
      meta: { target: ['classId', 'studentId'] },
    });
  }

  beforeAll(async () => {
    const teacherEmail = `reg-held-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Reg', lastName: 'Held',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'registrations-route held-booking fixture teacher',
        pageSlug: `reg-held-${suffix}`,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Reg Held Studio', address: `${suffix} Held St`, city: 'Amsterdam',
        postcode: '1234RH', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });

    const cls = await createClassFixture(prisma, {
      teacherId, teacherRoomId: teacherRoom.id,
      classType: 'Reg Held Vinyasa',
      date: new Date('2099-08-03'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 8,
      status: 'open',
    });
    classId = cls.id;

    // `tierSelectedAt` stays null: the unchanged answer must not write it.
    const studentEmail = `reg-held-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Reg', lastName: 'Held',
        email: studentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    const studentAccountId = student.accountId;
    if (!studentAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(studentAccountId);
    token = await seedSession(prisma, studentAccountId);

    await prisma.registration.create({
      data: { classId, studentId, status: 'registered', tierAtBooking: 3 },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  // Must run first: it needs the row this describe's `beforeAll` seeds as
  // `registered`, and every sibling below mutates that row's status before
  // asserting against it.
  it('answers unchanged, and writes neither the tier marker nor a notification', async () => {
    const before = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId } },
    });

    const res = await book();

    expect(await expectUnchanged(res)).toEqual({ id: before.id, status: 'registered' });
    const after = await prisma.registration.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    const marker = await prisma.student.findUniqueOrThrow({
      where: { id: studentId },
      select: { tierSelectedAt: true },
    });
    expect(marker.tierSelectedAt).toBeNull();
    expect(await prisma.notification.count({ where: { relatedClassId: classId } })).toBe(0);
  });

  it('answers the twin of a booking that committed first as unchanged', async () => {
    const row = await prisma.registration.update({
      where: { classId_studentId: { classId, studentId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    const twin = vi
      .spyOn(waitlistService, 'activateRegistration')
      .mockImplementationOnce(async () => {
        await prisma.registration.update({
          where: { id: row.id },
          data: { status: 'registered', cancelledAt: null },
        });
        throw uniqueViolation();
      });
    onTestFinished(() => twin.mockRestore());

    const res = await book();

    expect(twin).toHaveBeenCalledTimes(1);
    expect(await expectUnchanged(res)).toEqual({ id: row.id, status: 'registered' });
    expect(await prisma.notification.count({ where: { relatedClassId: classId } })).toBe(0);
  });

  /**
   * The re-read has to find an ACTIVE row. A twin cancelled again before the
   * re-read proves nothing about this request, so the violation reaches
   * `withErrorHandler` like any other.
   */
  it('lets a unique violation whose twin is no longer active reach the error handler', async () => {
    await prisma.registration.update({
      where: { classId_studentId: { classId, studentId } },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    const twin = vi
      .spyOn(waitlistService, 'activateRegistration')
      .mockRejectedValueOnce(uniqueViolation());
    onTestFinished(() => twin.mockRestore());
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => warn.mockRestore());

    const res = await book();

    expect(twin).toHaveBeenCalledTimes(1);
    await expectRefusal(res, 'UNIQUE_CONFLICT');
  });
});

/**
 * A teacher registering someone at the door who is not on their roster: a
 * pending invitee by `invitationId`, or a new person by `newContact`. The
 * service's own cases are `services/walk-ins.test.ts`; this block pins what
 * the route decides around it — the discriminator, the window, the rate
 * limit, the refusal codes, and that a refusal leaves nothing behind.
 *
 * The acting teacher's account also holds a student profile, so every case
 * that books the invitee also proves the route did not book the teacher.
 */
describe('POST /api/registrations — walk-ins (#255)', () => {
  const tag = `walkin-route-${suffix}`;
  /** Every fixture teacher's `defaultTimezone`: a class's wall-clock start is read in it. */
  const teacherTimezone = 'UTC';
  let main: { id: string; accountId: string; teacherRoomId: string };
  let teacherStudentId: string;
  let token: string;
  let otherTeacherId: string;
  let otherClassId: string;
  let studentOnlyToken: string;
  let inWindowId: string;
  let farOffId: string;
  const teacherIds: string[] = [];
  const accountIds: string[] = [];
  const roomIds: string[] = [];
  const classIds: string[] = [];

  const address = (label: string): string => `${tag}-${label}@test.local`;

  async function post(sessionToken: string, body: unknown): Promise<Response> {
    return POST(new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(body),
    }));
  }

  async function seedTeacher(label: string): Promise<{ id: string; accountId: string; teacherRoomId: string }> {
    const email = address(`${label}-teacher`);
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Walk', lastName: label,
        email,
        account: { create: { email } },
        bio: '#255 registrations-route walk-in fixture teacher',
        pageSlug: `${tag}-${label}`,
        defaultTimezone: teacherTimezone,
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    const room = await prisma.room.create({
      data: {
        venueName: 'Walk Route Studio', address: `${label} ${suffix} Walk St`, city: 'Amsterdam',
        postcode: '1234WR', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacher.id,
      },
      select: { id: true },
    });
    roomIds.push(room.id);
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });
    return { id: teacher.id, accountId: teacher.accountId, teacherRoomId: teacherRoom.id };
  }

  /** A class of this teacher; `inProgress` puts it inside the walk-in window. */
  async function seedClass(
    owner: { id: string; teacherRoomId: string },
    date: string,
    inProgress: boolean,
  ): Promise<string> {
    const cls = await createClassFixture(prisma, {
      teacherId: owner.id, teacherRoomId: owner.teacherRoomId,
      classType: 'Walk Route Vinyasa',
      date: new Date(date),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 8,
      status: 'open',
    });
    classIds.push(cls.id);
    if (inProgress) {
      await prisma.class.update({ where: { id: cls.id }, data: { status: 'in_progress' } });
    }
    return cls.id;
  }

  /**
   * An `open` class of this teacher starting `minutes` from now, on the
   * teacher's own wall clock. The start is stored to the minute, so it lands
   * up to a minute earlier than asked. One minute long, so two of them a few
   * minutes apart never share the teacher's slot.
   */
  async function seedClassStartingIn(
    owner: { id: string; teacherRoomId: string },
    minutes: number,
  ): Promise<string> {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: teacherTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date(Date.now() + minutes * 60 * 1000))
      .reduce<Record<string, string>>((acc, { type, value }) => {
        if (type !== 'literal') acc[type] = value;
        return acc;
      }, {});
    const cls = await createClassFixture(prisma, {
      teacherId: owner.id, teacherRoomId: owner.teacherRoomId,
      classType: 'Walk Route Soon',
      date: new Date(`${parts.year}-${parts.month}-${parts.day}`),
      startTime: hhmmToTime(`${parts.hour}:${parts.minute}`),
      durationMinutes: 1,
      roomCost: 25, minRate: 15, targetRate: 25,
      // 0: a class this close to its start must never read as below minimum.
      minStudents: 0, maxStudents: 8,
      status: 'open',
    });
    classIds.push(cls.id);
    return cls.id;
  }

  async function invite(owner: string, label: string): Promise<{ id: string; email: string }> {
    const email = address(label);
    const row = await prisma.invitation.create({
      data: { teacherId: owner, email, firstName: 'Walk', lastName: label, status: 'pending' },
      select: { id: true },
    });
    return { id: row.id, email };
  }

  /** A claimed student with a session of their own. */
  async function seedClaimedStudent(
    label: string,
    incomeTier: number,
  ): Promise<{ id: string; email: string; token: string }> {
    const email = address(label);
    const student = await prisma.student.create({
      data: {
        firstName: 'Walk', lastName: label,
        email, incomeTier, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    const accountId = student.accountId;
    if (!accountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(accountId);
    return { id: student.id, email, token: await seedSession(prisma, accountId) };
  }

  async function rowsFor(email: string): Promise<{ student: number; invitation: number; privacy: number }> {
    return {
      student: await prisma.student.count({ where: { email } }),
      invitation: await prisma.invitation.count({ where: { email } }),
      privacy: await prisma.studentPrivacy.count({ where: { student: { email } } }),
    };
  }

  beforeAll(async () => {
    main = await seedTeacher('main');
    // The dual role: the same account holds a student profile.
    const own = await prisma.student.create({
      data: {
        firstName: 'Walk', lastName: 'Main',
        email: address('main-teacher'), incomeTier: 3, claimedAt: new Date(),
        accountId: main.accountId,
      },
      select: { id: true },
    });
    teacherStudentId = own.id;
    token = await seedSession(prisma, main.accountId);

    inWindowId = await seedClass(main, '2099-09-01', true);
    farOffId = await seedClass(main, '2099-09-08', false);

    const other = await seedTeacher('other');
    otherTeacherId = other.id;
    otherClassId = await seedClass(other, '2099-09-01', true);

    studentOnlyToken = (await seedClaimedStudent('student-only', 3)).token;
  });

  afterAll(async () => {
    // Every address here carries this run's tag, so a student a failing case
    // created without recording it is still found.
    const students = await prisma.student.findMany({
      where: { email: { startsWith: tag, endsWith: '@test.local' } },
      select: { id: true },
    });
    const studentIds = students.map((s) => s.id);
    if (classIds.length) {
      await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
      await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
    }
    if (studentIds.length) {
      await prisma.notification.deleteMany({
        where: { recipientType: 'student', recipientId: { in: studentIds } },
      });
    }
    if (teacherIds.length) {
      await prisma.notification.deleteMany({
        where: { recipientType: 'teacher', recipientId: { in: teacherIds } },
      });
      // Cascades to each entry's `Class`.
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    }
    if (roomIds.length) await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
    if (accountIds.length) {
      await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    if (studentIds.length) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherIds.length) await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    // Last, and after both profiles: `Student.accountId` and
    // `Teacher.accountId` are plain FKs with no cascade.
    if (accountIds.length) await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  it('walks in a pending invitee, at their own tier', async () => {
    const invitee = await seedClaimedStudent('invitee-tier', 2);
    const invitation = await invite(main.id, 'invitee-tier');

    const res = await post(token, { classId: inWindowId, invitationId: invitation.id });

    expect(res.status).toBe(201);
    const reg = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: inWindowId, studentId: invitee.id } },
      select: { isWalkIn: true, tierAtBooking: true, status: true },
    });
    expect(reg).toEqual({ isWalkIn: true, tierAtBooking: 2, status: 'registered' });
    // A walk-in is not the person's tier choice: their first own booking still asks.
    expect(
      await prisma.student.findUniqueOrThrow({ where: { id: invitee.id }, select: { tierSelectedAt: true } }),
    ).toEqual({ tierSelectedAt: null });
  });

  it('walks in a new person without stamping their tier choice', async () => {
    const email = address('new-person');

    const res = await post(token, {
      classId: inWindowId,
      newContact: { firstName: 'New', lastName: 'Person', email },
    });

    expect(res.status).toBe(201);
    const student = await prisma.student.findUniqueOrThrow({
      where: { email },
      select: { id: true, tierSelectedAt: true },
    });
    expect(student.tierSelectedAt).toBeNull();
    const reg = await prisma.registration.findUnique({
      where: { classId_studentId: { classId: inWindowId, studentId: student.id } },
      select: { isWalkIn: true },
    });
    expect(reg).toEqual({ isWalkIn: true });
  });

  it('answers the two branches in the same shape', async () => {
    const invitation = await invite(main.id, 'shape-invitee');
    const byInvitation = await post(token, { classId: inWindowId, invitationId: invitation.id });
    const byContact = await post(token, {
      classId: inWindowId,
      newContact: { firstName: 'Shape', email: address('shape-contact') },
    });

    expect([byInvitation.status, byContact.status]).toEqual([201, 201]);
    const a = (await byInvitation.json()) as { data: Record<string, unknown> };
    const b = (await byContact.json()) as { data: Record<string, unknown> };
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Object.keys(a.data).sort()).toEqual(Object.keys(b.data).sort());
  });

  it('refuses both subjects outside the walk-in window, leaving nothing behind', async () => {
    const invitation = await invite(main.id, 'far-invitee');
    await expectRefusal(
      await post(token, { classId: farOffId, invitationId: invitation.id }),
      'WALK_IN_WINDOW_CLOSED',
    );
    expect(await prisma.registration.count({ where: { classId: farOffId } })).toBe(0);
    expect(
      await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id }, select: { status: true } }),
    ).toEqual({ status: 'pending' });

    const email = address('far-contact');
    await expectRefusal(
      await post(token, { classId: farOffId, newContact: { firstName: 'Far', email } }),
      'WALK_IN_WINDOW_CLOSED',
    );
    expect(await rowsFor(email)).toEqual({ student: 0, invitation: 0, privacy: 0 });
  });

  /**
   * The window's opening edge on an `open` class, the door case: each class
   * starts several minutes to one side of `WALK_IN_WINDOW_MS`.
   */
  it('walks in both subjects to an open class starting in about ten minutes', async () => {
    const classId = await seedClassStartingIn(main, 10);
    const invitation = await invite(main.id, 'soon-invitee');
    const email = address('soon-contact');

    const byInvitation = await post(token, { classId, invitationId: invitation.id });
    const byContact = await post(token, { classId, newContact: { firstName: 'Soon', email } });

    expect([byInvitation.status, byContact.status]).toEqual([201, 201]);
    const regs = await prisma.registration.findMany({ where: { classId }, select: { isWalkIn: true } });
    expect(regs).toEqual([{ isWalkIn: true }, { isWalkIn: true }]);
  });

  it('refuses both subjects to an open class starting in about twenty minutes, leaving nothing behind', async () => {
    const classId = await seedClassStartingIn(main, 20);
    const invitation = await invite(main.id, 'later-invitee');
    const email = address('later-contact');

    await expectRefusal(
      await post(token, { classId, invitationId: invitation.id }),
      'WALK_IN_WINDOW_CLOSED',
    );
    await expectRefusal(
      await post(token, { classId, newContact: { firstName: 'Later', email } }),
      'WALK_IN_WINDOW_CLOSED',
    );
    expect(await prisma.registration.count({ where: { classId } })).toBe(0);
    expect(
      await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id }, select: { status: true } }),
    ).toEqual({ status: 'pending' });
    expect(await rowsFor(email)).toEqual({ student: 0, invitation: 0, privacy: 0 });
  });

  /**
   * Outside the window the refusal comes before the "already booked" answer.
   * Otherwise a teacher could post a guessed address into their own future
   * class and read `unchanged` for one of their booked students, and a
   * refusal for anyone else, with nothing written and nobody told.
   */
  it('refuses a walk-in of a student already booked in a class outside the window', async () => {
    const booked = await seedClaimedStudent('booked-far', 3);
    const classId = await seedClass(main, '2099-09-22', false);
    expect((await post(booked.token, { classId })).status).toBe(201);
    const invitation = await invite(main.id, 'booked-far');

    await expectRefusal(
      await post(token, { classId, newContact: { firstName: 'Guess', email: booked.email } }),
      'WALK_IN_WINDOW_CLOSED',
    );
    await expectRefusal(
      await post(token, { classId, invitationId: invitation.id }),
      'WALK_IN_WINDOW_CLOSED',
    );
  });

  /**
   * A class that has started stays inside the walk-in window forever, so the
   * status refusal also comes before the "already booked" answer. Otherwise
   * every past class would answer `unchanged` for a booked student's guessed
   * address and a refusal for anyone else.
   */
  it('refuses a walk-in of a student already booked in a completed class', async () => {
    const booked = await seedClaimedStudent('booked-completed', 3);
    const classId = await seedClass(main, '2020-01-06', false);
    await prisma.registration.create({
      data: { classId, studentId: booked.id, tierAtBooking: 3, status: 'attended' },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'completed' } });
    const invitation = await invite(main.id, 'booked-completed');

    await expectRefusal(
      await post(token, { classId, newContact: { firstName: 'Guess', email: booked.email } }),
      'CLASS_NOT_BOOKABLE',
    );
    await expectRefusal(
      await post(token, { classId, invitationId: invitation.id }),
      'CLASS_NOT_BOOKABLE',
    );
  });

  it("refuses a new person into another teacher's class, leaving nothing behind", async () => {
    const email = address('foreign-class');

    const res = await post(token, { classId: otherClassId, newContact: { firstName: 'Foreign', email } });

    expect(res.status).toBe(403);
    expect(await rowsFor(email)).toEqual({ student: 0, invitation: 0, privacy: 0 });
  });

  it('refuses a blocked invitee, an erased one, a declined address and a foreign invitation by code', async () => {
    const blocked = await invite(main.id, 'blocked');
    await prisma.teacherBlock.create({ data: { teacherId: main.id, email: blocked.email } });
    await expectRefusal(
      await post(token, { classId: inWindowId, invitationId: blocked.id }),
      'WALK_IN_REFUSED',
    );

    const erased = await prisma.invitation.create({
      data: { teacherId: main.id, email: erasedAddress(crypto.randomUUID()), status: 'pending' },
      select: { id: true },
    });
    await expectRefusal(
      await post(token, { classId: inWindowId, invitationId: erased.id }),
      'INVITATION_ERASED',
    );

    const declined = address('declined');
    await prisma.invitation.create({
      data: { teacherId: main.id, email: declined, status: 'declined', respondedAt: new Date() },
    });
    await expectRefusal(
      await post(token, { classId: inWindowId, newContact: { firstName: 'Declined', email: declined } }),
      'DECLINED',
    );

    const foreign = await invite(otherTeacherId, 'foreign-invitation');
    await expectRefusal(
      await post(token, { classId: inWindowId, invitationId: foreign.id }),
      'NOT_FOUND',
    );
  });

  it("books the invitee, not the dual-role teacher's own student profile", async () => {
    const invitation = await invite(main.id, 'dual-role');

    const res = await post(token, { classId: inWindowId, invitationId: invitation.id });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const reg = await prisma.registration.findUniqueOrThrow({ where: { id: data.id }, select: { studentId: true } });
    const invitee = await prisma.student.findUniqueOrThrow({
      where: { email: invitation.email },
      select: { id: true },
    });
    expect(reg.studentId).toBe(invitee.id);
    expect(reg.studentId).not.toBe(teacherStudentId);
    expect(
      await prisma.student.findUniqueOrThrow({
        where: { id: teacherStudentId },
        select: { tierSelectedAt: true },
      }),
    ).toEqual({ tierSelectedAt: null });
  });

  it('refuses a student-only session posting an invitation', async () => {
    const invitation = await invite(main.id, 'student-session');

    const res = await post(studentOnlyToken, { classId: inWindowId, invitationId: invitation.id });

    expect(res.status).toBe(403);
  });

  it('refuses a body naming two subjects', async () => {
    const invitation = await invite(main.id, 'two-subjects');

    const res = await post(token, {
      classId: inWindowId, studentId: teacherStudentId, invitationId: invitation.id,
    });

    expect(res.status).toBe(400);
  });

  it('matches a mixed-case new-contact address to the existing student', async () => {
    const existing = await seedClaimedStudent('anna.case', 3);
    const mixed = existing.email.replace('anna.case', 'Anna.Case').replace('test.local', 'Test.Local');
    expect(mixed).not.toBe(existing.email);

    const res = await post(token, {
      classId: inWindowId,
      newContact: { firstName: 'Anna', lastName: 'Case', email: mixed },
    });

    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const reg = await prisma.registration.findUniqueOrThrow({ where: { id: data.id }, select: { studentId: true } });
    expect(reg.studentId).toBe(existing.id);
    expect(
      await prisma.student.count({ where: { email: { equals: existing.email, mode: 'insensitive' } } }),
    ).toBe(1);
  });

  it('answers a double-tapped new contact once as applied and once as unchanged', async () => {
    const email = address('double-tap');
    const body = { classId: inWindowId, newContact: { firstName: 'Double', lastName: 'Tap', email } };

    const [first, second] = await Promise.all([post(token, body), post(token, body)]);

    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(await prisma.student.count({ where: { email } })).toBe(1);
  });

  it('answers an invitee who already booked this class as unchanged, with no walk-in notice', async () => {
    const invitee = await seedClaimedStudent('self-booked', 3);
    const invitation = await invite(main.id, 'self-booked');
    const classId = await seedClass(main, '2099-09-15', false);
    expect((await post(invitee.token, { classId })).status).toBe(201);
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    const res = await post(token, { classId, invitationId: invitation.id });

    await expectUnchanged(res);
    expect(
      await prisma.notification.count({
        where: { recipientType: 'student', recipientId: invitee.id, type: 'walk_in_added' },
      }),
    ).toBe(0);
  });

  it('spends the student-write budget on a new contact, not on an invitation', async () => {
    const limit = vi
      .spyOn(rateLimit, 'checkStudentWriteLimit')
      .mockReturnValue({ allowed: false, retryAfterSeconds: 600 });
    onTestFinished(() => limit.mockRestore());
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => warn.mockRestore());

    const email = address('rate-limited');
    const refused = await post(token, { classId: inWindowId, newContact: { firstName: 'Rate', email } });
    expect(refused.status).toBe(429);
    expect(await rowsFor(email)).toEqual({ student: 0, invitation: 0, privacy: 0 });

    const invitation = await invite(main.id, 'rate-invitee');
    const allowed = await post(token, { classId: inWindowId, invitationId: invitation.id });
    expect(allowed.status).toBe(201);
    expect(limit).toHaveBeenCalledTimes(1);
  });
});

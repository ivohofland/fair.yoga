import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';
import { createClassFixture } from '../../../../tests/class-fixtures';
import { inviteContact } from '@/services/invitations';
import { POST } from './route';

/**
 * What this route hands `resolveInvitationOnLink` (#418), pinned where it can
 * actually run.
 *
 * The rule itself — a booking returns a `pending` invitation to `accepted`
 * only when that same act created the roster link — belongs to
 * `services/link-consent.ts`, and `link-consent.test.ts` drives every cell of
 * it directly. What no test of that function can see is whether THIS handler
 * passes `linkTeacherStudent`'s own answer through or a literal: hardcode
 * `linkCreatedNow: true` at the call site and every one of those cases stays
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
  // The `linkCreatedNow: true` half of the pair below: a student the teacher
  // has invited but never linked. `unlinked` distinguishes this fixture from
  // `studentId`/`studentEmail`/`token` above, which stay CLAIMED and LINKED
  // for the decoy-probe case.
  let unlinkedStudentId: string;
  let unlinkedStudentEmail: string;
  let unlinkedToken: string;
  const accountIds: string[] = [];

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
    // through for. Claimed because `rosterLinkState` (`services/invitations.ts`)
    // hands an unclaimed student's address to any linked teacher regardless of
    // `shareEmail`, so an unclaimed fixture would meet `ALREADY_LINKED` on the
    // probe below and never produce a decoy at all. `shareEmail: false` is
    // written out rather than left to the default for the same reason
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
    await prisma.student.deleteMany({ where: { id: { in: [studentId, unlinkedStudentId] } } });
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
   * `TeacherStudent` link — and `linkCreatedNow` should therefore be `true`
   * when the handler hands it to `resolveInvitationOnLink`. Hardcode that
   * argument to `false` (or drop the call to `resolveInvitationOnLink`
   * entirely) and this is the test that dies; hardcode it to `true` and the
   * test above does. Neither is provable from one of them alone, which is why
   * they are a pair.
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
});

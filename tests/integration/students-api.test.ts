import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession, waitFor } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let teacherToken: string;
const studentIds: string[] = [];

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'CRM',
      lastName: 'Teacher',
      email: `crm-teacher-${suffix}@test.local`,
      account: { create: { email: `crm-teacher-${suffix}@test.local` } },
      bio: 'Teacher for CRM tests',
      pageSlug: `crm-teacher-${suffix}`,
    },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;

  // Create 25 students linked to this teacher
  for (let i = 0; i < 25; i++) {
    const student = await prisma.student.create({
      data: {
        firstName: `Student${String(i).padStart(2, '0')}`,
        lastName: 'Test',
        email: `crm-student-${suffix}-${i}@test.local`,
      },
    });
    studentIds.push(student.id);
    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });
  }

  // Create a student NOT linked to this teacher (should not appear)
  const unlinked = await prisma.student.create({
    data: {
      firstName: 'Unlinked',
      lastName: 'Student',
      email: `crm-unlinked-${suffix}@test.local`,
    },
  });
  studentIds.push(unlinked.id);

  teacherToken = await seedSession(prisma, teacherAccountId);
});

afterAll(async () => {
  if (teacherId) {
    await prisma.teacherStudent.deleteMany({
      where: { teacherId },
    });
  }
  if (teacherAccountId) {
    await prisma.session.deleteMany({
      where: { accountId: teacherAccountId },
    });
  }
  await prisma.student.deleteMany({
    where: { id: { in: studentIds } },
  });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

describe('GET /api/students', () => {
  it('returns paginated students for the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=1&pageSize=10`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(10);
    expect(json.data.total).toBe(25);
    expect(json.data.page).toBe(1);
    expect(json.data.pageSize).toBe(10);
  });

  it('returns page 3 with remaining students', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=3&pageSize=10`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(5);
    expect(json.data.total).toBe(25);
    expect(json.data.page).toBe(3);
  });

  it('filters by search term (name)', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Student00`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(1);
    expect(json.data.students[0].displayName).toBe('Student00 Test');
  });

  it('filters by search term (email)', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students?search=crm-student-${suffix}-1@`,
      { headers: cookie(teacherToken) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students.length).toBeGreaterThanOrEqual(1);
  });

  it('does not return students not linked to the teacher', async () => {
    const res = await fetch(`${BASE_URL}/api/students?search=Unlinked`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(0);
  });

  it('returns 401 without session', async () => {
    const res = await fetch(`${BASE_URL}/api/students`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/students', () => {
  // Budget accounting: every POST on `teacherToken` in this file spends one
  // hit against the same 50-per-hour bucket (`checkStudentWriteLimit`, keyed
  // on the teacher). The 401 cases cost nothing — auth runs before the
  // limiter. Do not add a running total here: it is a rule to check against,
  // not a count to keep in sync by hand, and the burst tests further down
  // each mint their own teacher precisely so they get a fresh bucket instead
  // of competing with this describe's spend.
  const newEmail = `crm-new-${suffix}@test.local`;

  it('creates an invitation and no student row', async () => {
    const linksBefore = await prisma.teacherStudent.count({ where: { teacherId } });

    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: newEmail,
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(Object.keys(json.data)).toEqual(['id']);

    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { id: json.data.id as string },
    });
    expect(invitation.teacherId).toBe(teacherId);
    expect(invitation.email).toBe(newEmail);
    expect(invitation.status).toBe('pending');

    // #166: the point of the change. Typing an address creates an invitation
    // and nothing else — no Student row appears out of thin air, and the
    // teacher's roster is exactly the size it was before the request.
    expect(await prisma.student.findUnique({ where: { email: newEmail } })).toBeNull();
    expect(await prisma.teacherStudent.count({ where: { teacherId } })).toBe(linksBefore);
  });

  it('returns 409 when the person is already invited', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: newEmail,
      }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    // ALREADY_INVITED, not ALREADY_LINKED: this refusal is about the
    // teacher's own pending invitation, which is theirs to know about.
    expect(json.error.code).toBe('ALREADY_INVITED');
    // F4, #166 review: the message must name the way out, not just the wall.
    // The invitation email is sent fire-and-forget, so a teacher whose send
    // failed meets this refusal when they retry — and removing the contact is
    // the recovery `DELETE /api/invitations/[id]` actually allows for a
    // pending row. Substring, not the whole sentence: what is pinned is that
    // the refusal points somewhere, not this month's wording.
    expect(json.error.message).toContain('remove the contact');
  });

  // The defect #166 exists to fix, inverted into a test. This used to be
  // 'links existing student to teacher without creating duplicate' — the old
  // route put a real, claimed person on a stranger's roster on the strength of
  // their email address alone.
  it('does not link an existing student', async () => {
    const linkedEmail = `crm-existing-${suffix}@test.local`;
    const existing = await prisma.student.create({
      data: {
        firstName: 'Already',
        lastName: 'Registered',
        email: linkedEmail,
        claimedAt: new Date(),
        account: { create: { email: linkedEmail } },
      },
      select: { id: true, accountId: true },
    });

    try {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({
          firstName: 'New',
          lastName: 'Person',
          email: linkedEmail,
        }),
      });
      expect(res.status).toBe(201);

      const link = await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId: existing.id } },
      });
      expect(link).toBeNull();
    } finally {
      // `existing` is a registered Student, so the POST above also fired
      // `notifyInvitee` (#166 task 8) fire-and-forget from the route (F1,
      // review) — regardless of whether the assertions above passed. The
      // wait lives HERE, not in `try` (F7, review): a `try`-only wait is
      // skipped by an earlier assertion failure, and it is exactly a
      // failing run that most needs this cleanup to actually land rather
      // than race the in-flight write and leave it stranded. `.catch`
      // swallows a genuine timeout so it can never replace — `finally`
      // throwing does override an in-flight exception from `try` in JS —
      // the real assertion failure with an unrelated one.
      await waitFor(
        () =>
          prisma.notification.findFirst({
            where: { recipientId: existing.id, type: 'teacher_invitation' },
          }),
        { description: "existing student's teacher_invitation notification (#166 task 8 delivery)" },
      ).catch(() => {});

      await prisma.notification.deleteMany({ where: { recipientId: existing.id } });
      await prisma.teacherStudent.deleteMany({ where: { studentId: existing.id } });
      await prisma.student.delete({ where: { id: existing.id } });
      await prisma.account.delete({ where: { id: existing.accountId! } });
    }
  });

  // The roster-link refusal — the other arm of the branch above, and the one
  // nothing covered until now. It matters more than an ordinary coverage gap:
  // that block in `inviteContact` is exactly where a future edit would
  // reintroduce a Student-existence branch, and the docblock's "do not add a
  // branch on `student === null`" is prose, which no test can enforce. Delete
  // the student/link block outright and this is the test that goes red.
  it('returns 409 ALREADY_LINKED for a student already on the roster', async () => {
    // One of the 25 seeded in the file's beforeAll: linked to this teacher
    // and carrying no invitation row, which is precisely the "booked a class
    // instead of being invited" case the branch exists for. Refusing tells
    // the teacher only about their own roster.
    const linked = await prisma.student.findUniqueOrThrow({
      where: { id: studentIds[0]! },
      select: { email: true },
    });

    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Already', lastName: 'Mine', email: linked.email }),
    });

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('ALREADY_LINKED');

    // A refusal, not a refusal-shaped success: no invitation was written
    // beside it.
    expect(
      await prisma.invitation.findUnique({
        where: { teacherId_email: { teacherId, email: linked.email } },
      }),
    ).toBeNull();
  });

  // `'returns 409 ALREADY_LINKED even when the stored address carries
  // uppercase'` used to live here (whole-branch review I2). Its premise is
  // gone (#170 Task 3b): the row it built is unrepresentable now
  // (`Student_email_lowercase_check`, Task 2), and the case-insensitive
  // roster-link lookup it certified was itself deleted (Task 3 —
  // `hasRosterLink` is a plain, case-SENSITIVE `findUnique` now, and every
  // stored address is lowercase by construction, so a same-case lookup is
  // not merely sufficient, it is the only state that can exist). Its
  // same-case behaviour was never unique to this test either — `'returns 409
  // ALREADY_LINKED for a student already on the roster'` above covers it
  // through the real route.

  // #166 made `createInvitationSchema` `.strict()`, and that is the one
  // user-visible behaviour change on this route besides the status codes.
  // Drop the `.strict()` and this is the only test that fails: `incomeTier`
  // would be stripped in silence and the request would 201. `incomeTier`
  // deliberately — it is a real Student column, it used to live on this
  // schema, and it is the student's own choice to make, never the teacher's.
  it('rejects an unknown key rather than stripping it', async () => {
    const strictEmail = `crm-strict-${suffix}@test.local`;

    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'Strict',
        lastName: 'Body',
        email: strictEmail,
        incomeTier: 1,
      }),
    });

    expect(res.status).toBe(400);
    expect(
      await prisma.invitation.findUnique({
        where: { teacherId_email: { teacherId, email: strictEmail } },
      }),
    ).toBeNull();
  });

  // The CRM is the one place in this app where one human types ANOTHER
  // human's address, so a case slip is silent: the teacher sees a pending
  // invitation and the student never sees a thing. `createInvitationSchema`
  // normalises `email` via `emailField` (src/lib/schemas.ts) at HTTP
  // ingress, which is what lets later tasks match an account to an
  // invitation with a plain, case-sensitive lookup instead of reaching for
  // `mode: 'insensitive'`.
  it('stores the invitation email lowercased', async () => {
    const typed = `CRM-Mixed-${suffix}@Test.Local`;

    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Mixed', lastName: 'Case', email: typed }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };

    const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: data.id } });
    expect(invitation.email).toBe(typed.toLowerCase());
  });

  it('returns 400 for invalid input', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: '', lastName: '', email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without session', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'No',
        lastName: 'Auth',
        email: 'noauth@test.local',
      }),
    });
    expect(res.status).toBe(401);
  });

  // Cleanup the invitations these tests created. Scoped to the shared
  // teacher, and safe to run wholesale: nothing else in this file holds an
  // invitation for `teacherId` past its own test.
  afterAll(async () => {
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
    }
  });
});

describe('POST /api/students — the enumeration oracle is closed (#166)', () => {
  // Fixtures inside the `try` and cleanup in the `finally`, per the
  // convention this file states at the burst tests below: a throw between
  // `student.create` and the cleanup would otherwise strand a Student and an
  // Account on the unique `victim-…` address, and the NEXT run's create would
  // then fail in here rather than where the real problem is. That matters
  // more for this test than for most — it is the one that goes red while
  // somebody is still getting `inviteContact` right.
  it('answers identically for a registered address and a free one', async () => {
    const victimEmail = `victim-${suffix}@test.local`;
    const freeEmail = `never-seen-${suffix}@test.local`;
    let victim: { id: string; accountId: string | null } | undefined;

    try {
      // A real, claimed student belonging to nobody in this test.
      victim = await prisma.student.create({
        data: {
          firstName: 'Real', lastName: 'Person', email: victimEmail,
          claimedAt: new Date(), account: { create: { email: victimEmail } },
        },
        select: { id: true, accountId: true },
      });

      const post = (email: string) =>
        fetch(`${BASE_URL}/api/students`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
          body: JSON.stringify({ firstName: 'Zzz', lastName: 'Qqq', email }),
        });

      const [taken, free] = await Promise.all([post(victimEmail), post(freeEmail)]);

      // Same status.
      expect(taken.status).toBe(free.status);
      expect(taken.status).toBe(201);

      // Same body shape, and no field that could carry the bit.
      type Body = { data: { id: string } };
      const takenJson = (await taken.json()) as Body;
      const freeJson = (await free.json()) as Body;
      expect(Object.keys(takenJson.data)).toEqual(['id']);
      expect(Object.keys(freeJson.data)).toEqual(Object.keys(takenJson.data));

      // And no side effect that distinguishes them: no link, no Student row
      // for the free address, and the victim's row untouched.
      const link = await prisma.teacherStudent.findUnique({
        where: { teacherId_studentId: { teacherId, studentId: victim.id } },
      });
      expect(link).toBeNull();
      expect(await prisma.student.findUnique({ where: { email: freeEmail } })).toBeNull();
      const after = await prisma.student.findUniqueOrThrow({ where: { id: victim.id } });
      expect(after.firstName).toBe('Real');

      // Both produced an invitation in the same state.
      for (const [email, body] of [
        [victimEmail, takenJson],
        [freeEmail, freeJson],
      ] as const) {
        const inv = await prisma.invitation.findUniqueOrThrow({
          where: { teacherId_email: { teacherId, email } },
        });
        expect(inv.status).toBe('pending');
        expect(inv.firstName).toBe('Zzz');
        // And the id in the body is THIS row's. Without this, a regression
        // that handed back the victim's Student id while still creating an
        // invitation beside it would satisfy every assertion above.
        expect(body.data.id).toBe(inv.id);
      }
    } finally {
      // `victim` is a registered Student, so `POST /api/students` above also
      // fired `notifyInvitee` (#166 task 8) fire-and-forget from the route
      // (F1, review) — regardless of whether the assertions above passed.
      // The wait lives HERE, not in `try` (F7, review): a `try`-only wait is
      // skipped by an earlier assertion failure, which is exactly the run
      // most likely to leave the shared database dirty if this cleanup
      // races the in-flight write instead of catching it.
      // `Notification.recipientId` has no FK to `Student` (schema.prisma),
      // so a delete that runs first leaves the row behind forever, not
      // merely late. `.catch` swallows a genuine timeout here so it can
      // never override — `finally` throwing does replace an in-flight
      // exception from `try` in JS — the real assertion failure above.
      if (victim) {
        await waitFor(
          () =>
            prisma.notification.findFirst({
              where: { recipientId: victim!.id, type: 'teacher_invitation' },
            }),
          { description: "victim's teacher_invitation notification (Task 3 oracle, #166 task 8 delivery)" },
        ).catch(() => {});
      }

      if (teacherId) {
        await prisma.invitation.deleteMany({ where: { teacherId } });
      }
      if (victim) {
        await prisma.notification.deleteMany({ where: { recipientId: victim.id } });
        await prisma.teacherStudent.deleteMany({ where: { studentId: victim.id } });
        await prisma.student.delete({ where: { id: victim.id } });
        if (victim.accountId) {
          await prisma.account.delete({ where: { id: victim.accountId } });
        }
      }
      // Only exists if the pre-#166 create-a-Student-from-an-email behaviour
      // has come back; swept anyway so a reappearing regression cannot strand
      // it on a unique address and break the next run's fixtures.
      const stray = await prisma.student.findUnique({ where: { email: freeEmail } });
      if (stray) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: stray.id } });
        await prisma.student.delete({ where: { id: stray.id } });
      }
    }
  });
});

describe('GET /api/students/[id] — profile-presence authorization', () => {
  const dualSuffix = `${suffix}-dual`;

  let dualTeacherId: string;
  let dualOwnStudentId: string;
  let dualAccountId: string;
  let dualToken: string;
  let rosterStudentId: string;
  let rosterAccountId: string;
  let rosterToken: string;
  // A second teacher the roster student ALSO shares with — the other half of
  // the privacy-scoping fixture below.
  let sharedTeacherId: string;
  let sharedTeacherAccountId: string;
  let sharedTeacherToken: string;

  const as = (token: string, path: string, init?: RequestInit) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
        ...cookie(token),
      },
    });

  beforeAll(async () => {
    const dualEmail = `stuapi-dual-${dualSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Dual',
        lastName: 'Matrix',
        email: dualEmail,
        bio: 'Authorization matrix fixtures',
        pageSlug: `stuapi-dual-${dualSuffix}`,
        account: { create: { email: dualEmail } },
      },
    });
    dualTeacherId = teacher.id;
    dualAccountId = teacher.accountId;
    const ownStudent = await prisma.student.create({
      data: {
        firstName: 'Dual',
        lastName: 'Matrix',
        email: dualEmail,
        claimedAt: new Date(),
        account: { connect: { id: dualAccountId } },
      },
    });
    dualOwnStudentId = ownStudent.id;
    dualToken = await seedSession(prisma, dualAccountId);

    const rosterEmail = `stuapi-roster-${dualSuffix}@test.local`;
    const roster = await prisma.student.create({
      data: {
        firstName: 'Rostered',
        lastName: 'Privately',
        email: rosterEmail,
        // A real phone number, so the `phone` assertions downstream are about
        // the flag rather than about an empty column. Neither teacher has
        // `sharePhone`, so both must read `null` — which, with no phone on the
        // fixture, they did whether the gate ran or not.
        phone: '+31600000167',
        claimedAt: new Date(),
        account: { create: { email: rosterEmail } },
      },
    });
    rosterStudentId = roster.id;
    rosterAccountId = roster.accountId!;
    await prisma.teacherStudent.create({
      data: { teacherId: dualTeacherId, studentId: rosterStudentId },
    });
    rosterToken = await seedSession(prisma, rosterAccountId);

    // Second teacher, same student, opposite settings. Both are on the
    // student's roster, so both reach the projection legitimately — what
    // separates them is only which StudentPrivacy row is theirs.
    const sharedEmail = `stuapi-shared-${dualSuffix}@test.local`;
    const sharedTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Shared',
        lastName: 'Teacher',
        email: sharedEmail,
        bio: 'Privacy-scoping fixtures',
        pageSlug: `stuapi-shared-${dualSuffix}`,
        account: { create: { email: sharedEmail } },
      },
    });
    sharedTeacherId = sharedTeacher.id;
    sharedTeacherAccountId = sharedTeacher.accountId;
    sharedTeacherToken = await seedSession(prisma, sharedTeacherAccountId);
    await prisma.teacherStudent.create({
      data: { teacherId: sharedTeacherId, studentId: rosterStudentId },
    });

    // Two rows, deliberately in this order: the permissive one is created
    // first, so an unscoped read that takes `studentPrivacy[0]` gets the
    // *open* flags. Without this the fixture would fail closed by luck.
    await prisma.studentPrivacy.create({
      data: {
        studentId: rosterStudentId,
        teacherId: sharedTeacherId,
        shareFullName: true,
        shareEmail: true,
      },
    });
    await prisma.studentPrivacy.create({
      data: { studentId: rosterStudentId, teacherId: dualTeacherId },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({
      where: {
        accountId: { in: [dualAccountId, rosterAccountId, sharedTeacherAccountId] },
      },
    });
    await prisma.studentPrivacy.deleteMany({
      where: { teacherId: { in: [dualTeacherId, sharedTeacherId] } },
    });
    await prisma.teacherStudent.deleteMany({
      where: { teacherId: { in: [dualTeacherId, sharedTeacherId] } },
    });
    await prisma.student.deleteMany({
      where: { id: { in: [dualOwnStudentId, rosterStudentId] } },
    });
    await prisma.teacher.deleteMany({
      where: { id: { in: [dualTeacherId, sharedTeacherId] } },
    });
    await prisma.account.deleteMany({
      where: { id: { in: [dualAccountId, rosterAccountId, sharedTeacherAccountId] } },
    });
  });

  it('a dual account reading its OWN student row takes the self path — full profile', async () => {
    const res = await as(dualToken, `/api/students/${dualOwnStudentId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { email?: string; lastName: string } };
    // Full profile, not the privacy-filtered teacher view.
    expect(body.data.email).toBeDefined();
    expect(body.data.lastName).toBe('Matrix');
  });

  /**
   * The student holds two `StudentPrivacy` rows: all-false for this teacher,
   * and `shareFullName`/`shareEmail` for `sharedTeacherId`, created first. That
   * is what makes this a test of the *scope* rather than of the default —
   * until the PR review of #167 the fixture had no privacy row at all, and a
   * missing row and a wrong-teacher row both project to `null`.
   *
   * Which mutation it catches was stated wrongly here, and the wrong statement
   * is the interesting one. It claimed a deleted `where: { teacherId }` in
   * `studentVisibilitySelect` reddens this test. It does not: the fixture's
   * all-false row belongs to the *requesting* teacher, so the projection's
   * `find` picks it out of the unscoped set and the response is unchanged.
   * Measured — with that `where` deleted this file is 34/34 green.
   *
   * What it catches is the pre-#167 pair: `studentPrivacy[0]` read against an
   * unscoped nested select. Then `[0]` is `sharedTeacherId`'s permissive row
   * and this test reddens with `Rostered Privately` and a real email, as does
   * the list test below (2 failed, measured). Neither half alone reddens
   * anything — see `ScopedVisibilityFlags` in `lib/student-visibility.ts` for
   * why, and for the mutation that does fail universally (dropping
   * `teacherId: true`, which fails at compile time).
   */
  it('a dual account reading a roster student sees only its OWN privacy row', async () => {
    const res = await as(dualToken, `/api/students/${rosterStudentId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { displayName: string; email: string | null; incomeTier?: number };
    };
    // A composed name with a last initial, and no email — the other teacher's
    // open flags must not reach this response. `email` is present and null
    // rather than absent: an absent key cannot be told apart from a route that
    // forgot to select the field (#167).
    expect(body.data.displayName).toBe('Rostered p.');
    expect(body.data.email).toBeNull();
    // No tier: there is no shareIncomeTier flag and #167 decided against one.
    expect(body.data.incomeTier).toBeUndefined();
  });

  /**
   * The positive direction, and the only one in this suite. Every other
   * privacy assertion here checks that something is withheld, which a
   * projection that returned `null` unconditionally would also satisfy — the
   * gate would look perfect and the app would be unusable. This is the
   * assertion that says the flags still let data through when set.
   */
  it('the teacher the student DID share with gets the full name and the real email', async () => {
    const res = await as(sharedTeacherToken, `/api/students/${rosterStudentId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { displayName: string; email: string | null; phone: string | null };
    };
    expect(body.data.displayName).toBe('Rostered Privately');
    expect(body.data.email).toBe(`stuapi-roster-${dualSuffix}@test.local`);
    // Still per-field: this row shares name and email, nothing else — and the
    // student does have a phone number, so this is the flag being read and not
    // an empty column.
    expect(body.data.phone).toBeNull();
  });

  it('a student-only session reading another student is denied', async () => {
    const res = await as(rosterToken, `/api/students/${dualOwnStudentId}`);
    expect(res.status).toBe(403);
  });

  // #167 mutation check: the two pre-existing list assertions (`filters by
  // search term (name)`, `maps counts to the right rows across a full page`)
  // fail if the route stops projecting at all — but only because `displayName`
  // goes missing, not because a privacy-restricted student's data leaked, since
  // those fixtures (`Student00`..`Student24`) are unclaimed and legitimately
  // show a full name either way. This is the assertion that actually exercises
  // gating on the LIST route, mirroring the detail-route test just above.
  it('the list withholds a surname and an email the student did not share', async () => {
    const res = await as(dualToken, '/api/students?page=1&pageSize=20');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { students: { displayName: string; email: string | null }[] };
    };
    const row = body.data.students.find((s) => s.displayName?.startsWith('Rostered'));
    expect(row).toBeDefined();
    expect(row!.displayName).toBe('Rostered p.');
    expect(row!.email).toBeNull();
  });
});

describe('GET /api/students — overduePayments', () => {
  let otherTeacherId: string;
  let roomId: string;
  const overdueClassIds: string[] = [];

  beforeAll(async () => {
    const room = await prisma.room.create({
      data: {
        venueName: 'Overdue Studio',
        address: `${suffix} Overdue St`,
        city: 'Amsterdam',
        postcode: '1111OD',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    const otherTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `crm-other-${suffix}@test.local`,
        account: { create: { email: `crm-other-${suffix}@test.local` } },
        bio: 'Scoping fixture for overdue counts',
        pageSlug: `crm-other-${suffix}`,
      },
    });
    otherTeacherId = otherTeacher.id;
    const otherTeacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacher.id, roomId: room.id, capacityOverride: 10, rentalRate: 30 },
    });

    async function createCompletedClass(
      ownerTeacherId: string,
      ownerTeacherRoomId: string,
      daysBack: number,
    ) {
      const date = new Date();
      date.setDate(date.getDate() - daysBack);
      date.setHours(0, 0, 0, 0);
      const cls = await createClassFixture(prisma, {
          teacherId: ownerTeacherId,
          teacherRoomId: ownerTeacherRoomId,
          classType: 'Vinyasa',
          date,
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'completed',
          settingsLocked: true,
        });
      overdueClassIds.push(cls.id);
      return cls;
    }

    async function createChargedRegistration(
      classId: string,
      studentId: string,
      paymentStatus: 'overdue' | 'pending' | 'paid',
    ) {
      const reg = await prisma.registration.create({
        data: {
          classId,
          studentId,
          status: 'attended',
          tierAtBooking: 3,
          price: 6.11,
          tierRatio: 1.0,
        },
      });
      await prisma.payment.create({
        data: { registrationId: reg.id, amount: 6.11, status: paymentStatus },
      });
    }

    const clsA = await createCompletedClass(teacherId, teacherRoom.id, 9);
    const clsB = await createCompletedClass(teacherId, teacherRoom.id, 11);
    const clsC = await createCompletedClass(teacherId, teacherRoom.id, 15);
    const clsOther = await createCompletedClass(otherTeacherId, otherTeacherRoom.id, 13);

    // Student00: two overdue payments with the requesting teacher, plus a
    // paid one that must not widen the count.
    await createChargedRegistration(clsA.id, studentIds[0]!, 'overdue');
    await createChargedRegistration(clsB.id, studentIds[0]!, 'overdue');
    await createChargedRegistration(clsC.id, studentIds[0]!, 'paid');
    // Student01: overdue payment with the OTHER teacher only.
    await createChargedRegistration(clsOther.id, studentIds[1]!, 'overdue');
    // Student02: pending (not overdue) with the requesting teacher.
    await createChargedRegistration(clsA.id, studentIds[2]!, 'pending');
  });

  afterAll(async () => {
    // Guards: on a failed beforeAll roomId/otherTeacherId are undefined —
    // an undefined filter turns deleteMany into delete-all, and delete()
    // throws. overdueClassIds is safe unguarded: `in: []` matches nothing.
    await prisma.class.deleteMany({ where: { id: { in: overdueClassIds } } });
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (otherTeacherId) {
      await prisma.teacher.delete({ where: { id: otherTeacherId } });
    }
    await prisma.account.deleteMany({
      where: { email: `crm-other-${suffix}@test.local` },
    });
  });

  async function fetchSingleStudent(search: string) {
    const res = await fetch(`${BASE_URL}/api/students?search=${search}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.students).toHaveLength(1);
    return json.data.students[0];
  }

  it('counts overdue payments for the requesting teacher', async () => {
    const student = await fetchSingleStudent('Student00');
    expect(student.overduePayments).toBe(2);
  });

  it('ignores overdue payments owed to other teachers', async () => {
    const student = await fetchSingleStudent('Student01');
    expect(student.overduePayments).toBe(0);
  });

  it('does not count pending payments', async () => {
    const student = await fetchSingleStudent('Student02');
    expect(student.overduePayments).toBe(0);
  });

  it('maps counts to the right rows across a full page', async () => {
    const res = await fetch(`${BASE_URL}/api/students?page=1&pageSize=10`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    const byName = new Map<string, number>(
      json.data.students.map(
        (s: { displayName: string; overduePayments: number }) => [s.displayName, s.overduePayments],
      ),
    );
    expect(byName.get('Student00 Test')).toBe(2);
    expect(byName.get('Student01 Test')).toBe(0);
    expect(byName.get('Student02 Test')).toBe(0);
    // Student03 has no registrations at all.
    expect(byName.get('Student03 Test')).toBe(0);
  });
});

describe('PATCH /api/students/[id]', () => {
  // A dedicated student + link rather than reusing the shared 25: GET
  // /api/students filters to isArchived: false by default, so archiving one
  // of the shared fixtures would silently drop it out of the earlier
  // pagination and overdue-payments assertions above.
  let patchStudentId: string;
  let linkId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherToken: string;

  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Patch',
        lastName: 'Target',
        email: `stuapi-patch-${suffix}@test.local`,
      },
    });
    patchStudentId = student.id;

    const link = await prisma.teacherStudent.create({
      data: { teacherId, studentId: patchStudentId },
    });
    linkId = link.id;

    // A teacher with no link to `patchStudentId` at all — the non-owner
    // fixture for the ownership-order case below.
    const otherEmail = `stuapi-patch-other-${suffix}@test.local`;
    const other = await prisma.teacher.create({
      data: {
        firstName: 'Patch',
        lastName: 'Other',
        email: otherEmail,
        account: { create: { email: otherEmail } },
        bio: 'Non-owner fixture for PATCH /api/students/[id]',
        pageSlug: `stuapi-patch-other-${suffix}`,
      },
    });
    otherTeacherId = other.id;
    otherAccountId = other.accountId;
    otherToken = await seedSession(prisma, otherAccountId);
  });

  afterAll(async () => {
    await prisma.teacherStudent.deleteMany({ where: { id: linkId } });
    await prisma.student.delete({ where: { id: patchStudentId } });
    await prisma.session.deleteMany({ where: { accountId: otherAccountId } });
    await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.delete({ where: { id: otherAccountId } });
  });

  const patch = (query = '', token = teacherToken) =>
    fetch(`${BASE_URL}/api/students/${patchStudentId}${query}`, {
      method: 'PATCH',
      headers: cookie(token),
    });

  it('rejects a missing state rather than falling back to a toggle', async () => {
    const res = await patch();
    expect(res.status).toBe(400);

    const after = await prisma.teacherStudent.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(false);
  });

  it('rejects an unrecognised state', async () => {
    const res = await patch('?state=nonsense');
    expect(res.status).toBe(400);
  });

  // Pins the 'Student not in your contacts' 403 (nowhere else in this file
  // does), and does so with `?state=unarchived` — the state the link is
  // already in at this point in the file — deliberately. The lookup here is
  // keyed on `{ teacherId, studentId }`, so a non-owner's query can never
  // find a row to compare `isArchived` against in the first place; unlike
  // the class-template and teacher-room families, there is no separate
  // "fetch by id, then check ownership" step to reorder. Still worth
  // pinning explicitly rather than leaving that guarantee implicit.
  it("refuses a PATCH from a teacher not in the student's contacts, even for the state the link is already in", async () => {
    const res = await patch('?state=unarchived', otherToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Student not in your contacts');

    const after = await prisma.teacherStudent.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(false);
  });

  it('sets the state it names, and repeating it is a no-op that reports unchanged', async () => {
    const first = await patch('?state=archived');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { isArchived: boolean; action: string } };
    expect(firstBody.data.isArchived).toBe(true);
    expect(firstBody.data.action).toBe('archived');

    const second = await patch('?state=archived');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { isArchived: boolean; action: string } };
    expect(secondBody.data.isArchived).toBe(true);
    expect(secondBody.data.action).toBe('unchanged');

    const after = await prisma.teacherStudent.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(true);
  });

  // The un-archive arm of the same toggle, live at `/students/archived` —
  // nothing until now asserted that `?state=unarchived` actually reverses the
  // archive rather than merely accepting the request.
  it('un-archives, and repeating it is a no-op that reports unchanged', async () => {
    const archive = await patch('?state=archived');
    expect(archive.status).toBe(200);

    const first = await patch('?state=unarchived');
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { isArchived: boolean; action: string } };
    expect(firstBody.data.isArchived).toBe(false);
    expect(firstBody.data.action).toBe('unarchived');

    const second = await patch('?state=unarchived');
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { data: { isArchived: boolean; action: string } };
    expect(secondBody.data.isArchived).toBe(false);
    expect(secondBody.data.action).toBe('unchanged');

    const after = await prisma.teacherStudent.findUniqueOrThrow({ where: { id: linkId } });
    expect(after.isArchived).toBe(false);
  });
});

describe('POST /api/students — response disclosure (#162)', () => {
  let strangerId: string;
  let strangerAccountId: string;
  let strangerToken: string;
  let victimId: string;
  let victimAccountId: string;
  const victimEmail = `crm-victim-${suffix}@test.local`;

  beforeAll(async () => {
    // Account created first so `accountId` is a plain string here — the
    // Student_claim_link_check constraint needs claimedAt and accountId set
    // together, and this avoids a non-null assertion on victim.accountId.
    const victimAccount = await prisma.account.create({ data: { email: victimEmail } });
    victimAccountId = victimAccount.id;
    const victim = await prisma.student.create({
      data: {
        firstName: 'Victim',
        lastName: 'Surname',
        email: victimEmail,
        incomeTier: 5,
        phone: '+31 6 12345678',
        birthday: new Date('1988-03-14'),
        address: 'Kerkstraat 1, 1017 GA Amsterdam',
        claimedAt: new Date(),
        accountId: victimAccount.id,
      },
    });
    victimId = victim.id;

    const stranger = await prisma.teacher.create({
      data: {
        firstName: 'Stranger',
        lastName: 'Teacher',
        email: `crm-stranger-${suffix}@test.local`,
        account: { create: { email: `crm-stranger-${suffix}@test.local` } },
        bio: 'No relationship with the victim',
        pageSlug: `crm-stranger-${suffix}`,
      },
    });
    strangerId = stranger.id;
    strangerAccountId = stranger.accountId;
    strangerToken = await seedSession(prisma, strangerAccountId);
  });

  afterAll(async () => {
    // Guards, same shape as the two blocks above: on a failed beforeAll these
    // ids are undefined, an undefined filter turns deleteMany into delete-all
    // — every TeacherStudent row and every Session in the database, which logs
    // the developer out of the very server this suite talks to — and delete()
    // throws. Vitest runs afterAll even when beforeAll threw, and beforeAll
    // throwing is reachable: a crashed earlier run strands the victim Account,
    // so the next run's create fails on the unique email.
    if (strangerId) {
      await prisma.teacherStudent.deleteMany({ where: { teacherId: strangerId } });
    }
    if (strangerAccountId) {
      await prisma.session.deleteMany({ where: { accountId: strangerAccountId } });
    }
    if (strangerId) {
      await prisma.teacher.delete({ where: { id: strangerId } });
    }
    if (victimId) {
      // `victim` is a registered Student, so the `it()` below's POST also
      // fires `notifyInvitee` (#166 task 8) fire-and-forget from the route
      // (F1, review) — regardless of whether that test's own assertions
      // passed. The wait lives HERE, in `afterAll`, not in the `it()` body
      // (F7, review): vitest runs `afterAll` even when the test failed, and
      // a wait that only ran on the test's own success path would be
      // skipped by exactly the failing run most likely to leave this row
      // stranded. `.catch` swallows a genuine timeout so it can never
      // replace the original test failure with an unrelated one.
      await waitFor(
        () =>
          prisma.notification.findFirst({ where: { recipientId: victimId, type: 'teacher_invitation' } }),
        { description: "victim's teacher_invitation notification (#162 disclosure, #166 task 8 delivery)" },
      ).catch(() => {});
      await prisma.notification.deleteMany({ where: { recipientId: victimId } });
      await prisma.student.delete({ where: { id: victimId } });
    }
    const accountIds = [victimAccountId, strangerAccountId].filter(Boolean);
    if (accountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
  });

  // #162's regression test, kept and re-aimed by #166. #162 narrowed what the
  // response body carried; #166 changed what the request does at all. The
  // fixture is unchanged and so is the framing — a teacher who knows nothing
  // about the victim but their email address — but the id they get back is now
  // their own invitation, not a handle on a stranger's Student row.
  it('gives a teacher who knows only the email nothing but the id', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(strangerToken) },
      body: JSON.stringify({
        firstName: 'Anything',
        lastName: 'AtAll',
        email: victimEmail,
      }),
    });

    expect(res.status).toBe(201);
    const json = await res.json();
    // Exhaustive on keys, not field-by-field absence: a test that asserts
    // `phone === undefined` and three siblings cannot fail when someone later
    // adds a new sensitive column to Student. This one can.
    expect(Object.keys(json.data)).toEqual(['id']);

    // The id is the stranger's own invitation — a row they created — and
    // emphatically not the victim's student id. Handing that back is what
    // #162 was about, and returning it here would still be a disclosure even
    // with the body narrowed to one key.
    expect(json.data.id).not.toBe(victimId);
    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { id: json.data.id as string },
    });
    expect(invitation.teacherId).toBe(strangerId);
    expect(invitation.status).toBe('pending');

    // And no link: the victim never consented, so the stranger has no more
    // access to them after this request than before it.
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: strangerId, studentId: victimId } },
    });
    expect(link).toBeNull();
    // The wait for this POST's fire-and-forget `Notification` (#166 task 8,
    // F1) lives in this describe's `afterAll` now, not here — see F7 in the
    // round-2 review: a wait that only ran after every assertion in this
    // `it()` passed would be skipped by exactly the failing run most likely
    // to leave the row stranded.
  });

  // The three tests below sweep their fixtures from `afterEach`, not from a
  // `finally` of their own. Vitest does not abort a timed-out callback — it
  // stops awaiting it and lets the body run on as an orphan — so a `finally`
  // at the end of the burst test races the runway left in this file (the two
  // tests after it, ~1.4s) and loses in exactly the case that produced the
  // timeout: a server slow enough to need tens of seconds for the rest of the
  // loop. What is stranded then is a Teacher, its Account and a 24h Session,
  // and because every run's fixture is suffixed nothing ever collides on it —
  // a silent, cumulative leak in the shared dev database. A hook runs however
  // the test ended and carries its own budget. This is the `afterAll` argument
  // above, one scope down.
  //
  // Each test registers its sweep the moment `teacher.create` resolves and
  // before `seedSession` runs, so a throw in between cannot strand a Teacher
  // and Account — the invariant the old `try` gave, without the `finally`.
  // Each sweep still deletes rows before the Teacher they hang off, so a
  // failing teacher delete cannot leave them behind.
  type Fixture = { id: string; accountId: string };
  const sweeps: Array<() => Promise<void>> = [];

  afterEach(async () => {
    // `splice(0)` drains the queue as it reads it, so a sweep that throws
    // cannot replay against the next test's hook.
    for (const sweep of sweeps.splice(0)) await sweep();
  });

  // 51 DISTINCT addresses, deliberately. Repeating one address would now be
  // refused by `inviteContact`'s ALREADY_INVITED branch from the second
  // request on, so a run of 409s would prove the de-duplication works and say
  // nothing at all about the limiter — the 429 at the end would be the only
  // load-bearing assertion, and it would still arrive with the limiter
  // deleted if 409 were widened. Distinct addresses make all 51 requests ones
  // the route would otherwise accept.
  it('refuses a 51st invitation within the hour', async () => {
    const targets = Array.from(
      { length: 51 },
      (_, i) => `crm-burst-target-${i}-${suffix}@test.local`,
    );
    const burst: Fixture = await prisma.teacher.create({
      data: {
        firstName: 'Burst',
        lastName: 'Teacher',
        email: `crm-burst-${suffix}@test.local`,
        account: { create: { email: `crm-burst-${suffix}@test.local` } },
        bio: 'Fresh limiter bucket',
        pageSlug: `crm-burst-${suffix}`,
      },
    });
    sweeps.push(async () => {
      // The Student rows only exist if the regression this test guards has
      // returned: POST /api/students has created no Student since #166. Sweep
      // them anyway so a reappearing regression can't strand them in the
      // shared dev database. The burst teacher's invitations need no sweep —
      // Invitation cascades on teacher delete.
      const created = await prisma.student.findMany({
        where: { email: { in: targets } },
        select: { id: true },
      });
      if (created.length) {
        const ids = created.map((s) => s.id);
        await prisma.teacherStudent.deleteMany({ where: { studentId: { in: ids } } });
        await prisma.student.deleteMany({ where: { id: { in: ids } } });
      }
      await prisma.teacherStudent.deleteMany({ where: { teacherId: burst.id } });
      await prisma.session.deleteMany({ where: { accountId: burst.accountId } });
      await prisma.teacher.delete({ where: { id: burst.id } });
      await prisma.account.deleteMany({ where: { id: burst.accountId } });
    });
    const burstToken = await seedSession(prisma, burst.accountId);

    const statuses: number[] = [];
    for (const email of targets) {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(burstToken) },
        body: JSON.stringify({ firstName: 'Burst', lastName: 'Target', email }),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 50)).toEqual(Array(50).fill(201));
    expect(statuses[50]).toBe(429);
    // The longest fetch loop in the integration suite by an order of magnitude
    // — 51 sequential round trips where the next-largest is 2 — so this is the
    // most contention-sensitive test here, and it gets headroom the others do
    // not need. Steady state is ~0.8s (measured 2026-08-21 against a warm dev
    // server; the two sibling tests below make the same 51 round trips and
    // pass on the untouched 5s default). The budget is for a loaded or
    // cold-compiling server, not for solo latency — and a cold route is what
    // the warm-up protocol in AGENTS.md exists to remove, so this is the belt
    // to that braces (#290).
    //
    // Sequential is load-bearing independently of the budget: `statuses[50]`
    // is positional and `Promise.all` resolves in input order, so a concurrent
    // burst would leave the 429 at an unpredictable index. (The *count* would
    // stay exact — `checkRateLimit` is synchronous between its length check
    // and its push — so a count-based assertion would survive concurrency.
    // There is just nothing to buy: at ~0.8s the sequential form costs
    // nothing, and it says what it means.)
  }, 30_000);

  // Used to be shared with the teacher branch of PUT /api/students/[id] —
  // see the history in `checkStudentWriteLimit`'s docblock (`src/lib/
  // rate-limit.ts`). Task 10 of #166 deleted that branch, so the budget now
  // has one caller, and the claim worth pinning on POST alone is that the
  // limiter counts every call, not just the ones that create something:
  // repeated invites to an address already invited are refused with 409
  // ALREADY_INVITED by `inviteContact`, well after the limiter has already
  // run, and still spend a hit apiece.
  it('spends its budget on POST alone, refusals included', async () => {
    const shared: Fixture = await prisma.teacher.create({
      data: {
        firstName: 'Shared',
        lastName: 'Teacher',
        email: `crm-shared-${suffix}@test.local`,
        account: { create: { email: `crm-shared-${suffix}@test.local` } },
        bio: 'Fresh limiter bucket',
        pageSlug: `crm-shared-${suffix}`,
      },
    });
    sweeps.push(async () => {
      await prisma.invitation.deleteMany({ where: { teacherId: shared.id } });
      await prisma.session.deleteMany({ where: { accountId: shared.accountId } });
      await prisma.teacher.delete({ where: { id: shared.id } });
      await prisma.account.deleteMany({ where: { id: shared.accountId } });
    });

    const headers = {
      'Content-Type': 'application/json',
      ...cookie(await seedSession(prisma, shared.accountId)),
    };
    const repeatEmail = `crm-shared-repeat-${suffix}@test.local`;

    // Hit 1: a fresh invitation.
    const first = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ firstName: 'Shared', lastName: 'First', email: repeatEmail }),
    });
    expect(first.status).toBe(201);

    // Hits 2..49: the same address every time, refused as ALREADY_INVITED
    // — and still metered, since the limiter runs before `inviteContact`
    // ever sees the body.
    for (let i = 0; i < 48; i++) {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ firstName: 'Shared', lastName: 'Repeat', email: repeatEmail }),
      });
      expect(res.status).toBe(409);
    }

    // Hit 50: a fresh address still succeeds — the budget isn't exhausted
    // by refusals alone.
    const fiftieth = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        firstName: 'Shared', lastName: 'Fiftieth',
        email: `crm-shared-fiftieth-${suffix}@test.local`,
      }),
    });
    expect(fiftieth.status).toBe(201);

    // Hit 51: refused regardless of whether this particular request would
    // otherwise have succeeded.
    const refused = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        firstName: 'Shared', lastName: 'FiftyFirst',
        email: `crm-shared-fiftyfirst-${suffix}@test.local`,
      }),
    });
    expect(refused.status).toBe(429);
  });

  it('spends budget on invalid bodies, because the limiter runs before parseBody', async () => {
    const targetEmail = `crm-gate-target-${suffix}@test.local`;

    const gate: Fixture = await prisma.teacher.create({
      data: {
        firstName: 'Gate',
        lastName: 'Teacher',
        email: `crm-gate-${suffix}@test.local`,
        account: { create: { email: `crm-gate-${suffix}@test.local` } },
        bio: 'Fresh limiter bucket',
        pageSlug: `crm-gate-${suffix}`,
      },
    });
    sweeps.push(async () => {
      // Nothing keyed on `targetEmail` should exist: under correct behaviour
      // the 51st request is refused before `parseBody`, so no invitation is
      // written. Sweep anyway so a reappearing regression can't strand rows in
      // the shared dev database — and sweep Student too, in case the pre-#166
      // create-a-row-from-an-email behaviour comes back with it.
      const created = await prisma.student.findUnique({ where: { email: targetEmail } });
      if (created) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: created.id } });
        await prisma.student.delete({ where: { id: created.id } });
      }
      await prisma.invitation.deleteMany({ where: { email: targetEmail } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId: gate.id } });
      await prisma.session.deleteMany({ where: { accountId: gate.accountId } });
      await prisma.teacher.delete({ where: { id: gate.id } });
      await prisma.account.deleteMany({ where: { id: gate.accountId } });
    });
    const headers = {
      'Content-Type': 'application/json',
      ...cookie(await seedSession(prisma, gate.accountId)),
    };

    // 50 rejected bodies. Each 400s without creating anything, and each still
    // consumes a hit — that is the whole claim under test.
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ firstName: '', lastName: '', email: 'not-an-email' }),
      });
      expect(res.status).toBe(400);
    }

    // A flawless 51st request is refused anyway. Move the limiter below
    // parseBody and this returns 201 instead.
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        firstName: 'Valid',
        lastName: 'Payload',
        email: targetEmail,
      }),
    });
    expect(res.status).toBe(429);
  });
});

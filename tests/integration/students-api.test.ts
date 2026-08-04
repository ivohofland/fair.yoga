import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

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
  await prisma.teacherStudent.deleteMany({
    where: { teacherId },
  });
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
    expect(json.data.students[0].firstName).toBe('Student00');
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
  // Budget accounting: POST /api/students and the teacher branch of
  // PUT /api/students/[id] share one 50-per-hour bucket keyed on the teacher
  // (`checkStudentWriteLimit`). `teacherToken` spends 3 hits here — the create,
  // the 409 repeat, and the invalid body — plus 2 in the PUT describes at the
  // bottom of the file. The 401 cases cost nothing: auth runs before the
  // limiter. Anyone adding a run of requests on `teacherToken` should count
  // them against 50 rather than be surprised by a 429 unrelated to the
  // assertion under test; the burst tests below each mint their own teacher
  // precisely so they get a fresh bucket.
  let createdStudentId: string;

  it('creates a new student and TeacherStudent link', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${suffix}@test.local`,
      }),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(Object.keys(json.data)).toEqual(['id']);
    createdStudentId = json.data.id;

    // Verify TeacherStudent link was created
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: createdStudentId } },
    });
    expect(link).not.toBeNull();
  });

  it('returns 409 when student already in contacts', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${suffix}@test.local`,
      }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('ALREADY_LINKED');
  });

  it('links existing student to teacher without creating duplicate', async () => {
    // Create a second teacher
    const teacher2 = await prisma.teacher.create({
      data: {
        firstName: 'Second',
        lastName: 'Teacher',
        email: `crm-teacher2-${suffix}@test.local`,
        account: { create: { email: `crm-teacher2-${suffix}@test.local` } },
        bio: 'Second teacher',
        pageSlug: `crm-teacher2-${suffix}`,
      },
    });
    const rawToken2 = await seedSession(prisma, teacher2.accountId);

    // Teacher 2 adds the same student by email
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...cookie(rawToken2),
      },
      body: JSON.stringify({
        firstName: 'New',
        lastName: 'Person',
        email: `crm-new-${suffix}@test.local`,
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.id).toBe(createdStudentId); // Same student, no duplicate

    // Cleanup teacher2
    await prisma.teacherStudent.deleteMany({ where: { teacherId: teacher2.id } });
    await prisma.session.deleteMany({ where: { accountId: teacher2.accountId } });
    await prisma.teacher.delete({ where: { id: teacher2.id } });
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

  // Cleanup the created student
  afterAll(async () => {
    if (createdStudentId) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: createdStudentId } });
      await prisma.student.delete({ where: { id: createdStudentId } });
    }
  });
});

describe('GET/PUT /api/students/[id] — profile-presence authorization', () => {
  const dualSuffix = `${suffix}-dual`;

  let dualTeacherId: string;
  let dualOwnStudentId: string;
  let dualAccountId: string;
  let dualToken: string;
  let rosterStudentId: string;
  let rosterAccountId: string;
  let rosterToken: string;

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
  });

  afterAll(async () => {
    await prisma.session.deleteMany({
      where: { accountId: { in: [dualAccountId, rosterAccountId] } },
    });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: dualTeacherId } });
    await prisma.student.deleteMany({
      where: { id: { in: [dualOwnStudentId, rosterStudentId] } },
    });
    await prisma.teacher.deleteMany({ where: { id: dualTeacherId } });
    await prisma.account.deleteMany({
      where: { id: { in: [dualAccountId, rosterAccountId] } },
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

  it('a dual account reading a roster student gets the privacy-filtered view', async () => {
    const res = await as(dualToken, `/api/students/${rosterStudentId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { lastName: string; email?: string } };
    // Default privacy: last initial only, no email.
    expect(body.data.lastName).toBe('P');
    expect(body.data.email).toBeUndefined();
  });

  it('a student-only session reading another student is denied', async () => {
    const res = await as(rosterToken, `/api/students/${dualOwnStudentId}`);
    expect(res.status).toBe(403);
  });

  it('a teacher cannot edit a claimed student', async () => {
    const res = await as(dualToken, `/api/students/${rosterStudentId}`, {
      method: 'PUT',
      body: JSON.stringify({ firstName: 'Hijacked', lastName: 'Name', email: 'x@y.test' }),
    });
    expect(res.status).toBe(403);
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
      const cls = await prisma.class.create({
        data: {
          teacherId: ownerTeacherId,
          teacherRoomId: ownerTeacherRoomId,
          classType: 'Vinyasa',
          date,
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 30,
          minRate: 15,
          targetRate: 25,
          minStudents: 2,
          maxStudents: 10,
          status: 'completed',
          settingsLocked: true,
        },
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
        (s: { firstName: string; overduePayments: number }) => [s.firstName, s.overduePayments],
      ),
    );
    expect(byName.get('Student00')).toBe(2);
    expect(byName.get('Student01')).toBe(0);
    expect(byName.get('Student02')).toBe(0);
    // Student03 has no registrations at all.
    expect(byName.get('Student03')).toBe(0);
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
      await prisma.student.delete({ where: { id: victimId } });
    }
    const accountIds = [victimAccountId, strangerAccountId].filter(Boolean);
    if (accountIds.length) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
  });

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

    expect(res.status).toBe(200);
    const json = await res.json();
    // Exhaustive on keys, not field-by-field absence: a test that asserts
    // `phone === undefined` and three siblings cannot fail when someone later
    // adds a new sensitive column to Student. This one can.
    expect(Object.keys(json.data)).toEqual(['id']);
    expect(json.data.id).toBe(victimId);

    // The 200 has to mean the link was made, not merely that a row exists.
    // Delete the `teacherStudent.create` from that branch and every other
    // assertion in this file still passes, while the teacher gets a 200 with an
    // id, is redirected to that student, and lands on 403 Student not in your
    // contacts.
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: strangerId, studentId: victimId } },
    });
    expect(link).not.toBeNull();
  });

  // Fixture creation sits inside the `try` in the three tests below so a throw
  // in `teacher.create` or `seedSession` cannot strand a Teacher and Account —
  // and the finally deletes the Student before the Teacher, so a failing
  // teacher delete cannot leave the student row behind (and replace the real
  // assertion failure with a cleanup error).
  type Fixture = { id: string; accountId: string };

  it('refuses a 51st addition within the hour', async () => {
    const targetEmail = `crm-burst-target-${suffix}@test.local`;
    let burst: Fixture | undefined;

    try {
      burst = await prisma.teacher.create({
        data: {
          firstName: 'Burst',
          lastName: 'Teacher',
          email: `crm-burst-${suffix}@test.local`,
          account: { create: { email: `crm-burst-${suffix}@test.local` } },
          bio: 'Fresh limiter bucket',
          pageSlug: `crm-burst-${suffix}`,
        },
      });
      const burstToken = await seedSession(prisma, burst.accountId);

      const statuses: number[] = [];
      for (let i = 0; i < 51; i++) {
        const res = await fetch(`${BASE_URL}/api/students`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(burstToken) },
          body: JSON.stringify({ firstName: 'Burst', lastName: 'Target', email: targetEmail }),
        });
        statuses.push(res.status);
      }

      expect(statuses[0]).toBe(201);
      expect(statuses.slice(1, 50)).toEqual(Array(49).fill(409));
      expect(statuses[50]).toBe(429);
    } finally {
      const created = await prisma.student.findUnique({ where: { email: targetEmail } });
      if (created) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: created.id } });
        await prisma.student.delete({ where: { id: created.id } });
      }
      if (burst) {
        await prisma.teacherStudent.deleteMany({ where: { teacherId: burst.id } });
        await prisma.session.deleteMany({ where: { accountId: burst.accountId } });
        await prisma.teacher.delete({ where: { id: burst.id } });
        await prisma.account.deleteMany({ where: { id: burst.accountId } });
      }
    }
  });

  // The budget is shared across POST /api/students and the teacher branch of
  // PUT /api/students/[id] on purpose: the PUT writes a client-supplied email
  // to the same `@unique` column with no pre-check, so its 200-vs-409 answers
  // "is this address taken?" exactly as the POST's 200-vs-201 does. Give the
  // PUT its own bucket and the pair is unbounded again — and nothing else in
  // this file would notice.
  it('spends one shared budget across POST and the teacher PUT', async () => {
    let shared: Fixture | undefined;
    let studentId: string | undefined;

    try {
      shared = await prisma.teacher.create({
        data: {
          firstName: 'Shared',
          lastName: 'Teacher',
          email: `crm-shared-${suffix}@test.local`,
          account: { create: { email: `crm-shared-${suffix}@test.local` } },
          bio: 'Fresh limiter bucket',
          pageSlug: `crm-shared-${suffix}`,
        },
      });
      const headers = {
        'Content-Type': 'application/json',
        ...cookie(await seedSession(prisma, shared.accountId)),
      };

      // Hit 1 of 50: one real contact, the only Student row this test creates.
      const created = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          firstName: 'Shared',
          lastName: 'Budget',
          email: `crm-shared-0-${suffix}@test.local`,
        }),
      });
      expect(created.status).toBe(201);
      studentId = ((await created.json()) as { data: { id: string } }).data.id;

      // Hits 2..50: each PUT moves the contact's email to a fresh address, the
      // exact shape of the probe this budget exists to bound.
      for (let i = 1; i <= 49; i++) {
        const res = await fetch(`${BASE_URL}/api/students/${studentId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            firstName: 'Shared',
            lastName: 'Budget',
            email: `crm-shared-${i}-${suffix}@test.local`,
          }),
        });
        expect(res.status).toBe(200);
      }

      const refused = await fetch(`${BASE_URL}/api/students/${studentId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          firstName: 'Shared',
          lastName: 'Budget',
          email: `crm-shared-50-${suffix}@test.local`,
        }),
      });
      expect(refused.status).toBe(429);
    } finally {
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
      if (shared) {
        await prisma.teacherStudent.deleteMany({ where: { teacherId: shared.id } });
        await prisma.session.deleteMany({ where: { accountId: shared.accountId } });
        await prisma.teacher.delete({ where: { id: shared.id } });
        await prisma.account.deleteMany({ where: { id: shared.accountId } });
      }
    }
  });

  it('spends budget on invalid bodies, because the limiter runs before parseBody', async () => {
    const targetEmail = `crm-gate-target-${suffix}@test.local`;
    let gate: Fixture | undefined;

    try {
      gate = await prisma.teacher.create({
        data: {
          firstName: 'Gate',
          lastName: 'Teacher',
          email: `crm-gate-${suffix}@test.local`,
          account: { create: { email: `crm-gate-${suffix}@test.local` } },
          bio: 'Fresh limiter bucket',
          pageSlug: `crm-gate-${suffix}`,
        },
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
    } finally {
      // This row only exists if the regression this test guards has returned:
      // under correct behaviour every request is refused and no Student is
      // ever created. Clean it up anyway so a reappearing regression can't
      // strand it in the shared dev database.
      const created = await prisma.student.findUnique({ where: { email: targetEmail } });
      if (created) {
        await prisma.teacherStudent.deleteMany({ where: { studentId: created.id } });
        await prisma.student.delete({ where: { id: created.id } });
      }
      if (gate) {
        await prisma.teacherStudent.deleteMany({ where: { teacherId: gate.id } });
        await prisma.session.deleteMany({ where: { accountId: gate.accountId } });
        await prisma.teacher.delete({ where: { id: gate.id } });
        await prisma.account.deleteMany({ where: { id: gate.accountId } });
      }
    }
  });
});

describe('PUT /api/students/[id] — teacher response shape (#162)', () => {
  it('returns only the id when a teacher edits an unclaimed contact', async () => {
    const target = await prisma.student.create({
      data: {
        firstName: 'Editable',
        lastName: 'Contact',
        email: `crm-put-${suffix}@test.local`,
      },
    });
    studentIds.push(target.id); // cleaned up by the file's top-level afterAll
    await prisma.teacherStudent.create({
      data: { teacherId, studentId: target.id },
    });

    const res = await fetch(`${BASE_URL}/api/students/${target.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'Renamed',
        lastName: 'Contact',
        email: `crm-put-renamed-${suffix}@test.local`,
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Object.keys(json.data)).toEqual(['id']);
    expect(json.data.id).toBe(target.id);
  });

  // The unclaimed arm of the teacher branch's ownership gate. Its sibling — a
  // teacher editing a *claimed* student — is pinned above ("a teacher cannot
  // edit a claimed student"), but that 403 fires on `claimedAt` and returns
  // before the link check ever runs, so nothing until now could fail if the
  // link check were deleted.
  it("refuses a teacher editing an unclaimed student outside their contacts", async () => {
    const stranger = await prisma.student.create({
      data: {
        firstName: 'Not',
        lastName: 'Mine',
        email: `crm-put-unlinked-${suffix}@test.local`,
      },
    });
    studentIds.push(stranger.id); // cleaned up by the file's top-level afterAll

    const res = await fetch(`${BASE_URL}/api/students/${stranger.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({
        firstName: 'Hijacked',
        lastName: 'Mine',
        email: `crm-put-hijacked-${suffix}@test.local`,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Student not in your contacts');

    // And the write did not land.
    const after = await prisma.student.findUniqueOrThrow({ where: { id: stranger.id } });
    expect(after.firstName).toBe('Not');
    expect(after.email).toBe(`crm-put-unlinked-${suffix}@test.local`);
  });
});

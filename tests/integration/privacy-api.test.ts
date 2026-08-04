import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let studentId: string;
let studentAccountId: string;
let studentToken: string;
let otherStudentId: string;
let teacherId: string;
let unlinkedTeacherId: string;

describe('students privacy API', () => {
  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Privacy',
        lastName: 'Student',
        email: `privacy-student-${suffix}@test.local`,
        account: { create: { email: `privacy-student-${suffix}@test.local` } },
        claimedAt: new Date(),
      },
    });
    studentId = student.id;
    studentAccountId = student.accountId!;
    const other = await prisma.student.create({
      data: {
        firstName: 'Other',
        lastName: 'Student',
        email: `privacy-other-${suffix}@test.local`,
      },
    });
    otherStudentId = other.id;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Privacy',
        lastName: 'Teacher',
        email: `privacy-teacher-${suffix}@test.local`,
        account: { create: { email: `privacy-teacher-${suffix}@test.local` } },
        bio: 'Privacy fixture',
        pageSlug: `privacy-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;

    // The four tests below all PUT/GET privacy for this teacher. Until #146's
    // branch they passed with no TeacherStudent row at all — the route never
    // checked the teacher side, so the suite was exercising the hole.
    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });

    const unlinked = await prisma.teacher.create({
      data: {
        firstName: 'Unlinked',
        lastName: 'Teacher',
        email: `privacy-unlinked-${suffix}@test.local`,
        account: { create: { email: `privacy-unlinked-${suffix}@test.local` } },
        bio: 'Privacy fixture — no TeacherStudent link',
        pageSlug: `privacy-unlinked-${suffix}`,
      },
    });
    unlinkedTeacherId = unlinked.id;
    studentToken = await seedSession(prisma, studentAccountId);
  });

  afterAll(async () => {
    if (studentAccountId) {
      await prisma.session.deleteMany({ where: { accountId: studentAccountId } });
    }
    if (studentId) {
      await prisma.studentPrivacy.deleteMany({ where: { studentId } });
      await prisma.student.delete({ where: { id: studentId } });
    }
    if (otherStudentId) await prisma.student.delete({ where: { id: otherStudentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    // Teacher_accountId_fkey is ON DELETE RESTRICT — the account.deleteMany
    // below would FK-violate on this teacher's account if its Teacher row
    // were still present.
    if (unlinkedTeacherId) await prisma.teacher.delete({ where: { id: unlinkedTeacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${suffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  it('virtual default carries all six fields, maximum privacy', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students/${studentId}/privacy?teacherId=${teacherId}`,
      { headers: cookie(studentToken) },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.shareFullName).toBe(false);
    expect(data.shareEmail).toBe(false);
    expect(data.sharePhone).toBe(false);
    expect(data.shareBirthday).toBe(false);
    expect(data.shareAddress).toBe(false);
    expect(data.receiveComms).toBe(true);
  });

  it('first PUT persists all six fields — including shareFullName', async () => {
    const res = await fetch(`${BASE_URL}/api/students/${studentId}/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({
        teacherId,
        shareFullName: true,
        shareEmail: true,
        sharePhone: false,
        shareBirthday: false,
        shareAddress: false,
        receiveComms: false,
      }),
    });
    expect(res.status).toBe(200);
    const row = await prisma.studentPrivacy.findUniqueOrThrow({
      where: { studentId_teacherId: { studentId, teacherId } },
    });
    expect(row.shareFullName).toBe(true);
    expect(row.shareEmail).toBe(true);
    expect(row.receiveComms).toBe(false);
  });

  it('a second PUT revokes a share without disturbing the others, and GET returns the row', async () => {
    // The update arm is the revoke path: a regression here is a silent
    // privacy leak (student revokes, teacher keeps seeing the data).
    const res = await fetch(`${BASE_URL}/api/students/${studentId}/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ teacherId, shareEmail: false }),
    });
    expect(res.status).toBe(200);

    const row = await prisma.studentPrivacy.findUniqueOrThrow({
      where: { studentId_teacherId: { studentId, teacherId } },
    });
    expect(row.shareEmail).toBe(false);
    expect(row.shareFullName).toBe(true); // untouched by the partial update

    const get = await fetch(
      `${BASE_URL}/api/students/${studentId}/privacy?teacherId=${teacherId}`,
      { headers: cookie(studentToken) },
    );
    const { data } = await get.json();
    expect(data.shareEmail).toBe(false);
    expect(data.shareFullName).toBe(true);
    expect(data.receiveComms).toBe(false); // persisted row, not the virtual default
  });

  it('rejects a GET without teacherId', async () => {
    const res = await fetch(`${BASE_URL}/api/students/${studentId}/privacy`, {
      headers: cookie(studentToken),
    });
    expect(res.status).toBe(400);
  });

  it("rejects touching another student's privacy", async () => {
    const res = await fetch(
      `${BASE_URL}/api/students/${otherStudentId}/privacy?teacherId=${teacherId}`,
      { headers: cookie(studentToken) },
    );
    expect(res.status).toBe(403);
  });

  // A student could write privacy flags for any teacher, including one they
  // have no relationship with — the route proved the student side and never
  // touched the teacher side. Combined with #162 (a teacher can create the link
  // unilaterally knowing only an email), that pre-authorises disclosure to a
  // stranger.
  it('rejects a PUT for a teacher the student has no link to', async () => {
    const res = await fetch(`${BASE_URL}/api/students/${studentId}/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ teacherId: unlinkedTeacherId, shareAddress: true }),
    });
    expect(res.status).toBe(403);

    const row = await prisma.studentPrivacy.findUnique({
      where: { studentId_teacherId: { studentId, teacherId: unlinkedTeacherId } },
    });
    expect(row).toBeNull();
  });

  it('rejects a GET for a teacher the student has no link to', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students/${studentId}/privacy?teacherId=${unlinkedTeacherId}`,
      { headers: cookie(studentToken) },
    );
    expect(res.status).toBe(403);
  });
});

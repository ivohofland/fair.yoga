import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, uniqueSuffix, createSession } from './helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let studentId: string;
let studentAccountId: string;
let studentToken: string;
let otherStudentId: string;
let teacherId: string;

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
    studentToken = await createSession(prisma, studentAccountId);
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: studentAccountId } });
    if (studentId) {
      await prisma.studentPrivacy.deleteMany({ where: { studentId } });
      await prisma.student.delete({ where: { id: studentId } });
    }
    if (otherStudentId) await prisma.student.delete({ where: { id: otherStudentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
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
});

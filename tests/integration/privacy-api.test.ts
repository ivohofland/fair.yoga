import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  return encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const rawSessionToken = crypto.randomBytes(32).toString('hex');
const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=${rawSessionToken}`;

let studentId: string;
let otherStudentId: string;
let teacherId: string;

describe('students privacy API', () => {
  beforeAll(async () => {
    const student = await prisma.student.create({
      data: {
        firstName: 'Privacy',
        lastName: 'Student',
        email: `privacy-student-${uniqueSuffix}@test.local`,
        account: { create: { email: `privacy-student-${uniqueSuffix}@test.local` } },
        claimedAt: new Date(),
      },
    });
    studentId = student.id;
    const other = await prisma.student.create({
      data: {
        firstName: 'Other',
        lastName: 'Student',
        email: `privacy-other-${uniqueSuffix}@test.local`,
      },
    });
    otherStudentId = other.id;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Privacy',
        lastName: 'Teacher',
        email: `privacy-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `privacy-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Privacy fixture',
        pageSlug: `privacy-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    await prisma.session.create({
      data: {
        id: hashToken(rawSessionToken),
        accountId: student.accountId!,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { id: hashToken(rawSessionToken) } });
    if (studentId) {
      await prisma.studentPrivacy.deleteMany({ where: { studentId } });
      await prisma.student.delete({ where: { id: studentId } });
    }
    if (otherStudentId) await prisma.student.delete({ where: { id: otherStudentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({
      where: { email: { contains: `-${uniqueSuffix}@test.local` } },
    });
    await prisma.$disconnect();
  });

  it('virtual default carries all six fields, maximum privacy', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students/${studentId}/privacy?teacherId=${teacherId}`,
      { headers: { Cookie: sessionCookie } },
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
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
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
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
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
      { headers: { Cookie: sessionCookie } },
    );
    const { data } = await get.json();
    expect(data.shareEmail).toBe(false);
    expect(data.shareFullName).toBe(true);
    expect(data.receiveComms).toBe(false); // persisted row, not the virtual default
  });

  it('rejects a GET without teacherId', async () => {
    const res = await fetch(`${BASE_URL}/api/students/${studentId}/privacy`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(400);
  });

  it("rejects touching another student's privacy", async () => {
    const res = await fetch(
      `${BASE_URL}/api/students/${otherStudentId}/privacy?teacherId=${teacherId}`,
      { headers: { Cookie: sessionCookie } },
    );
    expect(res.status).toBe(403);
  });
});

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import {
  SESSION_COOKIE_NAME,
  createSession,
  validateSession,
  invalidateSession,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from './session';

const db = new PrismaClient();
const uniqueSuffix = Date.now();

// Three account shapes: teacher-only, student-only, dual (both profiles).
let teacherAccountId: string;
let studentAccountId: string;
let dualAccountId: string;
let teacherId: string;
let studentId: string;
let dualTeacherId: string;
let dualStudentId: string;

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

beforeAll(async () => {
  await db.$connect();

  const teacherAccount = await db.account.create({
    data: { email: `session-teacher-${uniqueSuffix}@test.local` },
  });
  teacherAccountId = teacherAccount.id;
  const teacher = await db.teacher.create({
    data: {
      accountId: teacherAccountId,
      firstName: 'Session',
      lastName: 'Teacher',
      email: teacherAccount.email,
      bio: 'Teacher for session tests',
      pageSlug: `session-teacher-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;

  const studentAccount = await db.account.create({
    data: { email: `session-student-${uniqueSuffix}@test.local` },
  });
  studentAccountId = studentAccount.id;
  const student = await db.student.create({
    data: {
      accountId: studentAccountId,
      firstName: 'Session',
      lastName: 'Student',
      email: studentAccount.email,
      claimedAt: new Date(),
    },
  });
  studentId = student.id;

  const dualAccount = await db.account.create({
    data: { email: `session-dual-${uniqueSuffix}@test.local` },
  });
  dualAccountId = dualAccount.id;
  const dualTeacher = await db.teacher.create({
    data: {
      accountId: dualAccountId,
      firstName: 'Dual',
      lastName: 'Hat',
      email: dualAccount.email,
      bio: 'Dual-role account for session tests',
      pageSlug: `session-dual-${uniqueSuffix}`,
    },
  });
  dualTeacherId = dualTeacher.id;
  const dualStudent = await db.student.create({
    data: {
      accountId: dualAccountId,
      firstName: 'Dual',
      lastName: 'Hat',
      email: dualAccount.email,
      claimedAt: new Date(),
    },
  });
  dualStudentId = dualStudent.id;
});

afterAll(async () => {
  const accountIds = [teacherAccountId, studentAccountId, dualAccountId];
  await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.student.deleteMany({ where: { id: { in: [studentId, dualStudentId] } } });
  await db.teacher.deleteMany({ where: { id: { in: [teacherId, dualTeacherId] } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
  await db.$disconnect();
});

afterEach(async () => {
  await db.session.deleteMany({
    where: { accountId: { in: [teacherAccountId, studentAccountId, dualAccountId] } },
  });
});

describe('SESSION_COOKIE_NAME', () => {
  it('equals fair_yoga_session', () => {
    expect(SESSION_COOKIE_NAME).toBe('fair_yoga_session');
  });
});

describe('createSession', () => {
  it('creates a session for an account and returns a 64-char hex token', async () => {
    const token = await createSession(db, teacherAccountId);

    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const session = await db.session.findUnique({ where: { id: hashToken(token) } });
    expect(session).not.toBeNull();
    expect(session!.accountId).toBe(teacherAccountId);
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('stores a hash as the session ID, not the raw token', async () => {
    const token = await createSession(db, teacherAccountId);

    expect(await db.session.findUnique({ where: { id: token } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: hashToken(token) } })).not.toBeNull();
  });
});

describe('validateSession', () => {
  it('resolves a teacher-only account: teacherId set, studentId null', async () => {
    const token = await createSession(db, teacherAccountId);

    const result = await validateSession(db, token);

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe(hashToken(token));
    expect(result!.accountId).toBe(teacherAccountId);
    expect(result!.teacherId).toBe(teacherId);
    expect(result!.studentId).toBeNull();
  });

  it('resolves a student-only account: studentId set, teacherId null', async () => {
    const token = await createSession(db, studentAccountId);

    const result = await validateSession(db, token);

    expect(result!.teacherId).toBeNull();
    expect(result!.studentId).toBe(studentId);
  });

  it('resolves a dual account: both profile ids set', async () => {
    const token = await createSession(db, dualAccountId);

    const result = await validateSession(db, token);

    expect(result!.teacherId).toBe(dualTeacherId);
    expect(result!.studentId).toBe(dualStudentId);
  });

  it('resolves only live profiles: a soft-deleted student side disappears', async () => {
    const token = await createSession(db, dualAccountId);
    await db.student.update({
      where: { id: dualStudentId },
      data: { deletedAt: new Date() },
    });

    const result = await validateSession(db, token);

    expect(result).not.toBeNull();
    expect(result!.teacherId).toBe(dualTeacherId);
    expect(result!.studentId).toBeNull();
    await db.student.update({ where: { id: dualStudentId }, data: { deletedAt: null } });
  });

  it('kills the session when every profile is soft-deleted', async () => {
    const token = await createSession(db, teacherAccountId);
    await db.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });

    const result = await validateSession(db, token);

    expect(result).toBeNull();
    expect(await db.session.findUnique({ where: { id: hashToken(token) } })).toBeNull();
    await db.teacher.update({ where: { id: teacherId }, data: { deletedAt: null } });
  });

  it('invalidates a session whose account has no profiles left', async () => {
    const bare = await db.account.create({
      data: { email: `session-bare-${uniqueSuffix}@test.local` },
    });
    const token = await createSession(db, bare.id);

    const result = await validateSession(db, token);

    expect(result).toBeNull();
    expect(await db.session.findUnique({ where: { id: hashToken(token) } })).toBeNull();
    await db.account.delete({ where: { id: bare.id } });
  });

  it('returns null for an expired session and deletes it', async () => {
    const token = await createSession(db, teacherAccountId);
    const sessionHash = hashToken(token);

    await db.session.update({
      where: { id: sessionHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await validateSession(db, token)).toBeNull();
    expect(await db.session.findUnique({ where: { id: sessionHash } })).toBeNull();
  });

  it('returns null for a non-existent token', async () => {
    expect(await validateSession(db, 'nonexistent-token-value')).toBeNull();
  });

  it('extends session expiry when session is more than 15 days old', async () => {
    const token = await createSession(db, teacherAccountId);
    const sessionHash = hashToken(token);

    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    const originalExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await db.session.update({
      where: { id: sessionHash },
      data: { createdAt: sixteenDaysAgo, expiresAt: originalExpiry },
    });

    const beforeValidate = Date.now();
    expect(await validateSession(db, token)).not.toBeNull();

    const session = await db.session.findUnique({ where: { id: sessionHash } });
    const thirtyDaysFromNow = beforeValidate + 30 * 24 * 60 * 60 * 1000;
    expect(session!.expiresAt.getTime()).toBeGreaterThan(thirtyDaysFromNow - 5000);
  });

  it('does NOT extend session expiry when session is less than 15 days old', async () => {
    const token = await createSession(db, studentAccountId);
    const sessionHash = hashToken(token);

    const original = (await db.session.findUnique({ where: { id: sessionHash } }))!.expiresAt;
    await validateSession(db, token);
    const after = (await db.session.findUnique({ where: { id: sessionHash } }))!.expiresAt;
    expect(after.getTime()).toBe(original.getTime());
  });
});

describe('invalidateSession', () => {
  it('deletes the session so subsequent validate returns null', async () => {
    const token = await createSession(db, teacherAccountId);

    expect(await validateSession(db, token)).not.toBeNull();
    await invalidateSession(db, token);
    expect(await validateSession(db, token)).toBeNull();
  });
});

describe('getSessionToken', () => {
  it('parses the session cookie from the Cookie header', () => {
    const request = new Request('http://localhost', {
      headers: { Cookie: 'fair_yoga_session=abc123; other=xyz' },
    });
    expect(getSessionToken(request)).toBe('abc123');
  });

  it('returns null when the session cookie is not present', () => {
    const request = new Request('http://localhost', {
      headers: { Cookie: 'other=xyz' },
    });
    expect(getSessionToken(request)).toBeNull();
  });

  it('returns null when there is no Cookie header', () => {
    expect(getSessionToken(new Request('http://localhost'))).toBeNull();
  });
});

describe('setSessionCookie', () => {
  it('sets a cookie with correct attributes', () => {
    const headers = new Headers();
    setSessionCookie(headers, 'my-token-value');

    const cookie = headers.get('Set-Cookie');
    expect(cookie).toContain('fair_yoga_session=my-token-value');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=2592000');
  });
});

describe('clearSessionCookie', () => {
  it('sets a cookie that expires immediately', () => {
    const headers = new Headers();
    clearSessionCookie(headers);

    const cookie = headers.get('Set-Cookie');
    expect(cookie).toContain('fair_yoga_session=');
    expect(cookie).toContain('Max-Age=0');
  });
});

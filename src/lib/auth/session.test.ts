import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import type { SessionUser, TeacherSession } from '../types';
import {
  SESSION_COOKIE_NAME,
  createSession,
  validateSession,
  invalidateSession,
  revokeRequestSession,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from './session';

const db = new PrismaClient();
const uniqueSuffix = Date.now();

// Test fixtures for each SessionUser profile variant.
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

/**
 * Narrows a `SessionUser` to the teacher branch so `defaultTimezone` is
 * readable. A named assertion rather than an inline `if (!x) throw`, which
 * sits among the `expect` calls and reads like one — this is narrowing, not
 * a check the test is making.
 */
function assertTeacherSession(user: SessionUser): asserts user is TeacherSession {
  if (!user.teacherId) throw new Error('expected a teacher session');
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
      defaultTimezone: 'America/Los_Angeles',
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
      defaultTimezone: 'Asia/Kolkata',
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
    assertTeacherSession(result!);
    expect(result!.defaultTimezone).toBe('America/Los_Angeles');
  });

  /**
   * Pins the teacher branch's key set. The bar for what may live on
   * `SessionUser` (see its docblock in `src/lib/types.ts`) is prose, and prose
   * is not enforced — this makes adding a field show up as a diff to an
   * explicit list instead. If this fails, read that bar before updating the
   * list: the question is whether the new field *computes* something on many
   * surfaces, or is merely cheap to carry.
   */
  it('the teacher branch carries exactly these keys', async () => {
    const token = await createSession(db, teacherAccountId);

    const result = await validateSession(db, token);

    expect(Object.keys(result!).sort()).toEqual([
      'accountId',
      'defaultTimezone',
      'sessionId',
      'studentId',
      'teacherId',
    ]);
  });

  it('resolves a student-only account: studentId set, teacherId null', async () => {
    const token = await createSession(db, studentAccountId);

    const result = await validateSession(db, token);

    expect(result!.teacherId).toBeNull();
    expect(result!.studentId).toBe(studentId);
  });

  /**
   * The union puts `defaultTimezone` on the teacher branch, so a student-only
   * session must not carry the key at all. Assert its *absence*, not that it is
   * `undefined` — the latter passes whether the key is missing or present and
   * empty, and the guarantee here is about the key.
   */
  it('omits defaultTimezone entirely for a student-only account', async () => {
    const token = await createSession(db, studentAccountId);

    const result = await validateSession(db, token);

    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty('defaultTimezone');
  });

  it('resolves a dual account: both profile ids set', async () => {
    const token = await createSession(db, dualAccountId);

    const result = await validateSession(db, token);

    expect(result!.teacherId).toBe(dualTeacherId);
    expect(result!.studentId).toBe(dualStudentId);
    assertTeacherSession(result!);
    expect(result!.defaultTimezone).toBe('Asia/Kolkata');
  });

  it('resolves only live profiles: a soft-deleted student side disappears', async () => {
    const token = await createSession(db, dualAccountId);
    await db.student.update({
      where: { id: dualStudentId },
      data: { deletedAt: new Date() },
    });

    try {
      const result = await validateSession(db, token);

      expect(result).not.toBeNull();
      expect(result!.teacherId).toBe(dualTeacherId);
      expect(result!.studentId).toBeNull();
    } finally {
      await db.student.update({ where: { id: dualStudentId }, data: { deletedAt: null } });
    }
  });

  /**
   * The soft-deleted-student case above is the trivially-safe path: the
   * student branch simply has no `defaultTimezone` to leak. This is the case
   * the field actually creates — a real teacher row with a real timezone
   * exists, and the session must degrade to the student branch without
   * carrying it along.
   */
  it('resolves only live profiles: a soft-deleted teacher side disappears, and defaultTimezone goes with it', async () => {
    const token = await createSession(db, dualAccountId);
    await db.teacher.update({
      where: { id: dualTeacherId },
      data: { deletedAt: new Date() },
    });

    try {
      const result = await validateSession(db, token);

      expect(result).not.toBeNull();
      expect(result!.teacherId).toBeNull();
      expect(result!.studentId).toBe(dualStudentId);
      expect(result).not.toHaveProperty('defaultTimezone');
    } finally {
      await db.teacher.update({ where: { id: dualTeacherId }, data: { deletedAt: null } });
    }
  });

  it('kills the session when every profile is soft-deleted', async () => {
    const token = await createSession(db, teacherAccountId);
    await db.teacher.update({ where: { id: teacherId }, data: { deletedAt: new Date() } });

    try {
      const result = await validateSession(db, token);

      expect(result).toBeNull();
      expect(await db.session.findUnique({ where: { id: hashToken(token) } })).toBeNull();
    } finally {
      await db.teacher.update({ where: { id: teacherId }, data: { deletedAt: null } });
    }
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

  it('re-throws database errors during expired session opportunistic deletion', async () => {
    const token = await createSession(db, teacherAccountId);
    const sessionHash = hashToken(token);

    await db.session.update({
      where: { id: sessionHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const deleteManySpy = vi
      .spyOn(db.session, 'deleteMany')
      .mockRejectedValueOnce(new Error('database connection lost'));

    try {
      await expect(validateSession(db, token)).rejects.toThrow('database connection lost');
    } finally {
      deleteManySpy.mockRestore();
    }
  });

  it('re-throws database errors during profile-less session opportunistic deletion', async () => {
    const bare = await db.account.create({
      data: { email: `session-bare-err-${uniqueSuffix}@test.local` },
    });
    const token = await createSession(db, bare.id);

    const deleteManySpy = vi
      .spyOn(db.session, 'deleteMany')
      .mockRejectedValueOnce(new Error('database deadlock'));

    try {
      await expect(validateSession(db, token)).rejects.toThrow('database deadlock');
    } finally {
      deleteManySpy.mockRestore();
      await db.session.deleteMany({ where: { accountId: bare.id } });
      await db.account.delete({ where: { id: bare.id } });
    }
  });

  it('returns null without throwing when session row is concurrently deleted during cleanup', async () => {
    const token = await createSession(db, teacherAccountId);
    const sessionHash = hashToken(token);

    await db.session.update({
      where: { id: sessionHash },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const realDeleteMany = db.session.deleteMany.bind(db.session);
    const deleteManySpy = vi.spyOn(db.session, 'deleteMany').mockImplementation(((args) => {
      return (async () => {
        // Concurrently delete before deleteMany runs, so deleteMany finds 0 rows
        await realDeleteMany({ where: { id: sessionHash } });
        const res = await realDeleteMany(args);
        expect(res.count).toBe(0);
        return res;
      })() as unknown as ReturnType<typeof realDeleteMany>;
    }) as typeof db.session.deleteMany);

    try {
      const result = await validateSession(db, token);
      expect(result).toBeNull();
      expect(deleteManySpy).toHaveBeenCalledTimes(1);
    } finally {
      deleteManySpy.mockRestore();
    }
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

  it('returns null when session is deleted between read and extension update (#632)', async () => {
    const token = await createSession(db, teacherAccountId);
    const sessionHash = hashToken(token);

    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    const originalExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await db.session.update({
      where: { id: sessionHash },
      data: { createdAt: sixteenDaysAgo, expiresAt: originalExpiry },
    });

    const realUpdate = db.session.update.bind(db.session);
    const updateSpy = vi.spyOn(db.session, 'update').mockImplementation(((args) => {
      return (async () => {
        // Simulate concurrent deletion (e.g. logout or GDPR erasure) between read and update
        await db.session.delete({ where: { id: sessionHash } });
        return realUpdate(args);
      })() as unknown as ReturnType<typeof realUpdate>;
    }) as typeof db.session.update);

    try {
      const result = await validateSession(db, token);
      expect(result).toBeNull();
      expect(updateSpy).toHaveBeenCalledTimes(1);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it('re-throws non-P2025 database errors during extension update', async () => {
    const token = await createSession(db, teacherAccountId);
    const sessionHash = hashToken(token);

    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    const originalExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await db.session.update({
      where: { id: sessionHash },
      data: { createdAt: sixteenDaysAgo, expiresAt: originalExpiry },
    });

    const updateSpy = vi
      .spyOn(db.session, 'update')
      .mockRejectedValueOnce(new Error('connection timeout'));

    try {
      await expect(validateSession(db, token)).rejects.toThrow('connection timeout');
    } finally {
      updateSpy.mockRestore();
    }
  });
});

describe('invalidateSession', () => {
  it('deletes the session so subsequent validate returns null and returns true', async () => {
    const token = await createSession(db, teacherAccountId);

    expect(await validateSession(db, token)).not.toBeNull();
    const result = await invalidateSession(db, token);
    expect(result).toBe(true);
    expect(await validateSession(db, token)).toBeNull();
  });

  it('returns false without throwing when token does not exist in the database', async () => {
    const nonExistentToken = '0'.repeat(64);
    const result = await invalidateSession(db, nonExistentToken);
    expect(result).toBe(false);
  });

  it('re-throws when the database delete operation fails', async () => {
    const dbError = new Error('database connection lost');
    const mockDb = {
      session: {
        deleteMany: vi.fn().mockRejectedValue(dbError),
      },
    } as unknown as PrismaClient;

    await expect(invalidateSession(mockDb, 'some-token')).rejects.toThrow('database connection lost');
  });
});

describe('revokeRequestSession', () => {
  it('returns false when request carries no session cookie', async () => {
    const request = new NextRequest('http://localhost');
    const result = await revokeRequestSession(db, request);
    expect(result).toBe(false);
  });

  it('revokes active session and returns true when session exists', async () => {
    const token = await createSession(db, teacherAccountId);
    const request = new NextRequest('http://localhost', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });

    expect(await validateSession(db, token)).not.toBeNull();
    const result = await revokeRequestSession(db, request);
    expect(result).toBe(true);
    expect(await validateSession(db, token)).toBeNull();
  });

  it('returns false without throwing when session cookie names an absent session', async () => {
    const nonExistentToken = '0'.repeat(64);
    const request = new NextRequest('http://localhost', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${nonExistentToken}` },
    });

    const result = await revokeRequestSession(db, request);
    expect(result).toBe(false);
  });
});

describe('getSessionToken', () => {
  it('parses the session cookie from the Cookie header', () => {
    const request = new NextRequest('http://localhost', {
      headers: { Cookie: 'fair_yoga_session=abc123; other=xyz' },
    });
    expect(getSessionToken(request)).toBe('abc123');
  });

  it('returns null when the session cookie is not present', () => {
    const request = new NextRequest('http://localhost', {
      headers: { Cookie: 'other=xyz' },
    });
    expect(getSessionToken(request)).toBeNull();
  });

  it('returns null when there is no Cookie header', () => {
    expect(getSessionToken(new NextRequest('http://localhost'))).toBeNull();
  });

  it('returns null for a present but empty session cookie', () => {
    const request = new NextRequest('http://localhost', {
      headers: { Cookie: 'fair_yoga_session=' },
    });
    expect(getSessionToken(request)).toBeNull();
  });

  // Presence of this cookie is also what gates the signup-ticket path
  // (`ticketTokenFrom`, profile-authorization.ts), which asks
  // `NextRequest.cookies`. Two readers that disagreed would let one route the
  // request to the ticket path while the other authenticates it — so what is
  // asserted here is the AGREEMENT, on a header the platform parser refuses.
  it('agrees with the request cookie store when a tab follows the separator', () => {
    const request = new NextRequest('http://localhost', {
      headers: { Cookie: 'other=1;\tfair_yoga_session=abc123' },
    });

    expect(request.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
    expect(getSessionToken(request)).toBeNull();
  });

  it('agrees with the request cookie store when the value is not decodable', () => {
    const request = new NextRequest('http://localhost', {
      headers: { Cookie: 'fair_yoga_session=%zz' },
    });

    expect(request.cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
    expect(getSessionToken(request)).toBeNull();
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

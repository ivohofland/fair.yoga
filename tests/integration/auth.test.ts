/**
 * Integration tests for the auth flow.
 *
 * Tests magic link generation/verification and session lifecycle
 * by calling the auth library functions directly against the DB.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import {
  createSession,
  validateSession,
  invalidateSession,
  generateMagicLinkToken,
  verifyMagicLinkToken,
} from '@/lib/auth';

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

let teacherId: string;
let studentId: string;
let teacherAccountId: string;
let studentAccountId: string;

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Auth',
      lastName: 'Teacher',
      email: `auth-teacher-${uniqueSuffix}@test.local`,
      account: { create: { email: `auth-teacher-${uniqueSuffix}@test.local` } },
      bio: 'Teacher for auth integration tests',
      pageSlug: `auth-teacher-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;

  const student = await prisma.student.create({
    data: {
      firstName: 'Auth',
      lastName: 'Student',
      email: `auth-student-${uniqueSuffix}@test.local`,
      incomeTier: 3,
      claimedAt: new Date(),
      account: { create: { email: `auth-student-${uniqueSuffix}@test.local` } },
    },
  });
  studentId = student.id;
  studentAccountId = student.accountId!;
});

afterAll(async () => {
  // Clean up sessions and tokens first, then users
  await prisma.session.deleteMany({
    where: { accountId: { in: [teacherAccountId, studentAccountId] } },
  });
  await prisma.magicLinkToken.deleteMany({
    where: {
      email: {
        in: [
          `auth-teacher-${uniqueSuffix}@test.local`,
          `auth-student-${uniqueSuffix}@test.local`,
        ],
      },
    },
  });
  await prisma.student.delete({ where: { id: studentId } });
  await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

describe('Magic link flow (teacher)', () => {
  it('generates token, verifies it, and creates a valid session', async () => {
    const email = `auth-teacher-${uniqueSuffix}@test.local`;

    // Generate magic link token
    const rawToken = await generateMagicLinkToken(prisma, email);
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

    // Verify token returns the email
    const result = await verifyMagicLinkToken(prisma, rawToken);
    expect(result).not.toBeNull();
    expect(result!.email).toBe(email);

    // Look up teacher by email
    const teacher = await prisma.teacher.findUnique({ where: { email } });
    expect(teacher).not.toBeNull();
    expect(teacher!.id).toBe(teacherId);

    // Create session
    const sessionToken = await createSession(prisma, teacherAccountId);
    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);

    // Validate session returns correct SessionUser
    const sessionUser = await validateSession(prisma, sessionToken);
    expect(sessionUser).not.toBeNull();
    expect(sessionUser!.accountId).toBe(teacherAccountId);
    expect(sessionUser!.teacherId).toBe(teacherId);
    expect(sessionUser!.sessionId).toBe(hashToken(sessionToken));
  });
});

describe('Magic link flow (student)', () => {
  it('generates token, verifies it, and creates a valid student session', async () => {
    const email = `auth-student-${uniqueSuffix}@test.local`;

    // Generate magic link token
    const rawToken = await generateMagicLinkToken(prisma, email);
    expect(rawToken).toMatch(/^[0-9a-f]{64}$/);

    // Verify token returns the email
    const result = await verifyMagicLinkToken(prisma, rawToken);
    expect(result).not.toBeNull();
    expect(result!.email).toBe(email);

    // Look up student by email
    const student = await prisma.student.findUnique({ where: { email } });
    expect(student).not.toBeNull();
    expect(student!.id).toBe(studentId);

    // Create session with student type
    const sessionToken = await createSession(prisma, studentAccountId);
    expect(sessionToken).toMatch(/^[0-9a-f]{64}$/);

    // Validate session returns student type
    const sessionUser = await validateSession(prisma, sessionToken);
    expect(sessionUser).not.toBeNull();
    expect(sessionUser!.accountId).toBe(studentAccountId);
    expect(sessionUser!.studentId).toBe(studentId);
  });
});

describe('Magic link token is one-time use', () => {
  it('succeeds on first verify, returns null on second verify', async () => {
    const email = `auth-teacher-${uniqueSuffix}@test.local`;

    const rawToken = await generateMagicLinkToken(prisma, email);

    // First verification succeeds
    const first = await verifyMagicLinkToken(prisma, rawToken);
    expect(first).not.toBeNull();
    expect(first!.email).toBe(email);

    // Second verification returns null (token was consumed)
    const second = await verifyMagicLinkToken(prisma, rawToken);
    expect(second).toBeNull();
  });
});

describe('Session invalidation (logout)', () => {
  it('invalidated session returns null on validate', async () => {
    const sessionToken = await createSession(prisma, teacherAccountId);

    // Session is valid
    const before = await validateSession(prisma, sessionToken);
    expect(before).not.toBeNull();
    expect(before!.teacherId).toBe(teacherId);

    // Invalidate (logout)
    await invalidateSession(prisma, sessionToken);

    // Session is no longer valid
    const after = await validateSession(prisma, sessionToken);
    expect(after).toBeNull();
  });
});

describe('Session expiry', () => {
  it('expired session returns null on validate', async () => {
    const sessionToken = await createSession(prisma, teacherAccountId);

    // Manually expire the session (use hash since that's what's stored in DB)
    await prisma.session.update({
      where: { id: hashToken(sessionToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // Validate returns null for expired session
    const result = await validateSession(prisma, sessionToken);
    expect(result).toBeNull();
  });
});

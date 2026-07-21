import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();
const rawSessionToken = crypto.randomBytes(32).toString('hex');

const BASE_URL = 'http://localhost:3000';
const sessionCookie = `fair_yoga_session=${rawSessionToken}`;

let teacherId: string;
let otherTeacherId: string;

async function putTeacher(
  id: string,
  body: Record<string, unknown>,
  cookie?: string,
): Promise<Response> {
  return fetch(`${BASE_URL}/api/teachers/${id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/teachers/[id]', () => {
  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Settings',
        lastName: 'Teacher',
        email: `settings-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `settings-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Teacher settings tests',
        pageSlug: `settings-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;

    const other = await prisma.teacher.create({
      data: {
        firstName: 'Other',
        lastName: 'Teacher',
        email: `settings-other-${uniqueSuffix}@test.local`,
        account: { create: { email: `settings-other-${uniqueSuffix}@test.local` } },
        bio: 'Ownership fixture',
        pageSlug: `settings-other-${uniqueSuffix}`,
      },
    });
    otherTeacherId = other.id;

    await prisma.session.create({
      data: {
        id: hashToken(rawSessionToken),
        accountId: teacher.accountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { id: hashToken(rawSessionToken) } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({
      where: {
        email: {
          in: [
            `settings-teacher-${uniqueSuffix}@test.local`,
            `settings-other-${uniqueSuffix}@test.local`,
          ],
        },
      },
    });
    await prisma.$disconnect();
  });

  it('updates and persists valid settings — resubmitting the own slug is not a conflict', async () => {
    const res = await putTeacher(
      teacherId,
      {
        bio: 'Updated bio',
        defaultTimezone: 'Europe/London',
        // The unchanged own slug must pass the conflict check: losing the
        // existing.id !== id exclusion would 409 every settings save.
        pageSlug: `settings-teacher-${uniqueSuffix}`,
      },
      sessionCookie,
    );
    expect(res.status).toBe(200);

    const persisted = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(persisted.bio).toBe('Updated bio');
    expect(persisted.defaultTimezone).toBe('Europe/London');
  });

  it('rejects unknown fields — the schema is strict', async () => {
    const res = await putTeacher(teacherId, { role: 'admin' }, sessionCookie);
    expect(res.status).toBe(400);
  });

  it('rejects a timezone Intl cannot resolve', async () => {
    const before = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });

    const res = await putTeacher(teacherId, { defaultTimezone: 'Not/AZone' }, sessionCookie);
    expect(res.status).toBe(400);

    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(after).toEqual(before);
  });

  it("rejects updating another teacher's profile", async () => {
    const res = await putTeacher(otherTeacherId, { bio: 'Hijacked' }, sessionCookie);
    expect(res.status).toBe(403);

    const persisted = await prisma.teacher.findUniqueOrThrow({ where: { id: otherTeacherId } });
    expect(persisted.bio).toBe('Ownership fixture');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await putTeacher(teacherId, { bio: 'Anonymous' });
    expect(res.status).toBe(401);
  });

  it("rejects claiming another teacher's page slug with the SLUG_TAKEN code", async () => {
    const res = await putTeacher(
      teacherId,
      { pageSlug: `settings-other-${uniqueSuffix}` },
      sessionCookie,
    );
    expect(res.status).toBe(409);
    // The code pins the deliberate pre-check: the P2002 fallback also
    // returns 409, but without SLUG_TAKEN the settings form can't render
    // its inline error.
    const json = (await res.json()) as { error: { code?: string } };
    expect(json.error.code).toBe('SLUG_TAKEN');
  });

  it("rejects reading another teacher's profile — the raw row carries bank details", async () => {
    const res = await fetch(`${BASE_URL}/api/teachers/${otherTeacherId}`, {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(403);
  });
});

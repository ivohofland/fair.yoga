import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { cookie, hashToken, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { GET } from './route';

const suffix = uniqueSuffix();

describe('GET /api/auth/session — session extension race (#632)', () => {
  let teacherId: string;
  let accountId: string;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `session-route-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Session',
        lastName: 'Route',
        email,
        bio: 'session route fixture',
        pageSlug: `session-route-${suffix}`,
        defaultTimezone: 'Europe/Amsterdam',
        account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('answers 401 Session expired (not 500) when session is deleted between read and extension update', async () => {
    const token = await seedSession(prisma, accountId);
    const sessionHash = hashToken(token);

    // Make the session older than 15 days so validateSession triggers extension update
    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    const originalExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await prisma.session.update({
      where: { id: sessionHash },
      data: { createdAt: sixteenDaysAgo, expiresAt: originalExpiry },
    });

    const errorSpy = vi.spyOn(log, 'error');
    const realUpdate = prisma.session.update.bind(prisma.session);
    const updateSpy = vi.spyOn(prisma.session, 'update').mockImplementation(((args) => {
      return (async () => {
        // Simulate concurrent deletion (e.g. logout or GDPR erasure)
        await prisma.session.delete({ where: { id: sessionHash } });
        return realUpdate(args);
      })() as unknown as ReturnType<typeof realUpdate>;
    }) as typeof prisma.session.update);

    try {
      const request = new NextRequest('http://localhost/api/auth/session', {
        headers: cookie(token),
      });

      const response = await GET(request);

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toEqual({
        error: { message: 'Session expired' },
      });

      expect(errorSpy).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledTimes(1);
    } finally {
      updateSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('answers 200 with account details on valid session extension', async () => {
    const token = await seedSession(prisma, accountId);
    const sessionHash = hashToken(token);

    const sixteenDaysAgo = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
    const originalExpiry = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    await prisma.session.update({
      where: { id: sessionHash },
      data: { createdAt: sixteenDaysAgo, expiresAt: originalExpiry },
    });

    const request = new NextRequest('http://localhost/api/auth/session', {
      headers: cookie(token),
    });

    const response = await GET(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      data: {
        accountId,
        teacherId,
        studentId: null,
      },
    });

    const session = await prisma.session.findUnique({ where: { id: sessionHash } });
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });
});

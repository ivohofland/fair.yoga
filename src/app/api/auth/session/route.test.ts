import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { log } from '@/lib/log';
import { cookie, hashToken, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { GET, DELETE } from './route';

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

/**
 * Route unit tests for `DELETE /api/auth/session`.
 *
 * Direct test of the route handler:
 * - When a session cookie is present, delegates revocation to `revokeRequestSession`
 *   and returns 200 with an expired cookie.
 * - When no session cookie is present, safely returns 200 with an expired cookie
 *   without querying the database.
 * - When session deletion encounters a database failure, bubbles out of the handler
 *   to `withErrorHandler`, which logs the error at `error` level and responds with HTTP 500.
 */
describe('DELETE /api/auth/session', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with logged out message and cleared cookie when session cookie is present', async () => {
    const deleteManySpy = vi.spyOn(prisma.session, 'deleteMany').mockResolvedValue({ count: 1 });

    const request = new NextRequest('http://localhost:3000/api/auth/session', {
      method: 'DELETE',
      headers: {
        cookie: 'fair_yoga_session=active-session-token',
      },
    });

    const res = await DELETE(request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { message: string } };
    expect(body.data.message).toBe('Logged out');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('fair_yoga_session=;');
    expect(setCookie).toContain('Max-Age=0');

    expect(deleteManySpy).toHaveBeenCalledTimes(1);
  });

  it('returns 200 with logged out message and cleared cookie when no session cookie is present', async () => {
    const deleteManySpy = vi.spyOn(prisma.session, 'deleteMany');

    const request = new NextRequest('http://localhost:3000/api/auth/session', {
      method: 'DELETE',
    });

    const res = await DELETE(request);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { message: string } };
    expect(body.data.message).toBe('Logged out');

    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('fair_yoga_session=;');
    expect(setCookie).toContain('Max-Age=0');

    expect(deleteManySpy).not.toHaveBeenCalled();
  });

  it('propagates database error to withErrorHandler, logging error and answering 500', async () => {
    const dbError = new Error('connection failed');
    vi.spyOn(prisma.session, 'deleteMany').mockRejectedValue(dbError);
    const logErrorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined as unknown as void);

    const request = new NextRequest('http://localhost:3000/api/auth/session', {
      method: 'DELETE',
      headers: {
        cookie: 'fair_yoga_session=active-session-token',
      },
    });

    const res = await DELETE(request);

    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Internal server error');

    expect(logErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        err: dbError,
        method: 'DELETE',
        path: '/api/auth/session',
      }),
      'unhandled API error',
    );
  });
});

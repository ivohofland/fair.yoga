import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SessionUser } from './types';

// Mock auth module before importing api-utils
vi.mock('./auth', () => ({
  getSessionToken: vi.fn(),
  validateSession: vi.fn(),
}));

// Mock db module
vi.mock('./db', () => ({
  prisma: {},
}));

// First log mock in the repo. api-utils.ts imports '@/lib/log'; the alias
// resolves to ./src via vitest.config.ts, so the specifier must match.
vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  respondOk,
  respondError,
  requireSession,
  requireTeacher,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from './api-utils';
import { getSessionToken, validateSession } from './auth';
import { Prisma } from '@prisma/client';
import { log } from '@/lib/log';

const mockedGetSessionToken = vi.mocked(getSessionToken);
const mockedValidateSession = vi.mocked(validateSession);

function makeRequest(
  url = 'http://localhost/api/test',
  init?: { method?: string; body?: string; headers?: Record<string, string> }
): NextRequest {
  return new NextRequest(url, init);
}

describe('respondOk', () => {
  it('returns NextResponse with { data } body and correct status', async () => {
    const response = respondOk({ name: 'test' }, 201);

    expect(response).toBeInstanceOf(NextResponse);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body).toEqual({ data: { name: 'test' } });
  });

  it('defaults to status 200', async () => {
    const response = respondOk({ items: [1, 2, 3] });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ data: { items: [1, 2, 3] } });
  });
});

describe('respondError', () => {
  it('returns NextResponse with { error: { message } } body and correct status', async () => {
    const response = respondError('Not found', 404);

    expect(response).toBeInstanceOf(NextResponse);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toEqual({ error: { message: 'Not found', code: undefined } });
  });

  it('includes code when provided', async () => {
    const response = respondError('Validation failed', 422, 'VALIDATION_ERROR');

    expect(response.status).toBe(422);

    const body = await response.json();
    expect(body).toEqual({
      error: { message: 'Validation failed', code: 'VALIDATION_ERROR' },
    });
  });
});

const testSchema = z.object({
  title: z.string(),
  spots: z.number(),
});

describe('parseBody', () => {
  it('returns { data } for valid JSON matching schema', async () => {
    const request = makeRequest('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ title: 'Yoga Class', spots: 10 }),
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parseBody(request, testSchema);
    expect('data' in result).toBe(true);
    if ('data' in result) {
      expect(result.data).toEqual({ title: 'Yoga Class', spots: 10 });
    }
  });

  it('returns { error } for invalid JSON', async () => {
    const request = makeRequest('http://localhost/api/test', {
      method: 'POST',
      body: 'not-json{{{',
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parseBody(request, testSchema);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(400);
    }
  });

  it('returns { error } when JSON does not match schema', async () => {
    const request = makeRequest('http://localhost/api/test', {
      method: 'POST',
      body: JSON.stringify({ title: 123, spots: 'not-a-number' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parseBody(request, testSchema);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.status).toBe(400);
    }
  });
});

describe('isErrorResponse', () => {
  it('returns true for NextResponse', () => {
    const response = NextResponse.json({ error: 'test' }, { status: 401 });
    expect(isErrorResponse(response)).toBe(true);
  });

  it('returns false for SessionUser', () => {
    const user: SessionUser = {
      sessionId: 'sess-1',
      accountId: 'acct-tea',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    };
    expect(isErrorResponse(user)).toBe(false);
  });
});

describe('requireSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 401 when no session token is present', async () => {
    mockedGetSessionToken.mockReturnValue(null);

    const request = makeRequest();
    const result = await requireSession(request);

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error.message).toBe('Authentication required');
  });

  it('returns 401 when session is expired/invalid', async () => {
    mockedGetSessionToken.mockReturnValue('expired-token');
    mockedValidateSession.mockResolvedValue(null);

    const request = makeRequest();
    const result = await requireSession(request);

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error.message).toBe('Session expired');
  });

  it('returns SessionUser when session is valid', async () => {
    const sessionUser: SessionUser = {
      sessionId: 'sess-abc',
      accountId: 'acct-tea',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    };
    mockedGetSessionToken.mockReturnValue('valid-token');
    mockedValidateSession.mockResolvedValue(sessionUser);

    const request = makeRequest();
    const result = await requireSession(request);

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(sessionUser);
  });
});

describe('requireTeacher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 403 when user is not a teacher', async () => {
    const studentUser: SessionUser = {
      sessionId: 'sess-stu',
      accountId: 'acct-stu',
      teacherId: null,
      studentId: 'student-1',
    };
    mockedGetSessionToken.mockReturnValue('valid-token');
    mockedValidateSession.mockResolvedValue(studentUser);

    const request = makeRequest();
    const result = await requireTeacher(request);

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error.message).toBe('Teacher access required');
  });

  it('returns SessionUser when user is a teacher', async () => {
    const teacherUser: SessionUser = {
      sessionId: 'sess-tea',
      accountId: 'acct-tea',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    };
    mockedGetSessionToken.mockReturnValue('valid-token');
    mockedValidateSession.mockResolvedValue(teacherUser);

    const request = makeRequest();
    const result = await requireTeacher(request);

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(teacherUser);
  });
});

describe('requireStudent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 403 when user is not a student', async () => {
    const teacherUser: SessionUser = {
      sessionId: 'sess-tea',
      accountId: 'acct-tea',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    };
    mockedGetSessionToken.mockReturnValue('valid-token');
    mockedValidateSession.mockResolvedValue(teacherUser);

    const request = makeRequest();
    const result = await requireStudent(request);

    expect(result).toBeInstanceOf(NextResponse);
    const response = result as NextResponse;
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error.message).toBe('Student access required');
  });

  it('returns SessionUser when user is a student', async () => {
    const studentUser: SessionUser = {
      sessionId: 'sess-stu',
      accountId: 'acct-stu',
      teacherId: null,
      studentId: 'student-1',
    };
    mockedGetSessionToken.mockReturnValue('valid-token');
    mockedValidateSession.mockResolvedValue(studentUser);

    const request = makeRequest();
    const result = await requireStudent(request);

    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(studentUser);
  });
});

describe('withErrorHandler', () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
  });

  it('logs the failing request method and path, then returns 500', async () => {
    const handler = withErrorHandler(async () => {
      throw new Error('kaboom');
    });

    const res = await handler(
      makeRequest('http://localhost/api/classes/abc123/transition', { method: 'POST' }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error' } });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        method: 'POST',
        path: '/api/classes/abc123/transition',
      }),
      'unhandled API error',
    );
  });

  /**
   * The bug this file's coverage was added for: the P2002 branch used to
   * return *above* the log line, so this 409 reached a teacher with no
   * server-side trace whatsoever.
   */
  it('logs an escaped P2002 at warn with its constraint, and still returns 409', async () => {
    const handler = withErrorHandler(async () => {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['teacherId', 'roomId'] },
      });
    });

    const res = await handler(
      makeRequest('http://localhost/api/teacher-rooms', { method: 'POST' }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { message: 'Resource already exists' } });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/teacher-rooms',
        target: ['teacherId', 'roomId'],
      }),
      expect.any(String),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  /**
   * Nine routes under src/app/api read searchParams. Logging nextUrl.href or
   * .search instead of .pathname would put every one of their query values in
   * the log; this pins the narrow choice so a future edit cannot widen it
   * quietly.
   */
  it('logs the path without the query string', async () => {
    const handler = withErrorHandler(async () => {
      throw new Error('kaboom');
    });

    await handler(
      makeRequest('http://localhost/api/students?search=alice&token=sensitive', {
        method: 'GET',
      }),
    );

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/students' }),
      'unhandled API error',
    );
    expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain('sensitive');
  });

  /**
   * The wrapper exists to stop stack traces leaking. If reading args[0] could
   * throw, a TypeError raised *inside* the catch would escape the wrapper —
   * strictly worse than the bug being fixed. TypeScript forbids this call, so
   * the cast simulates a JavaScript caller, which the types cannot see.
   */
  it('still returns 500 when invoked with no request at all', async () => {
    const handler = withErrorHandler(async () => {
      throw new Error('kaboom');
    }) as unknown as () => Promise<NextResponse>;

    const res = await handler();

    expect(res.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ method: undefined, path: undefined }),
      'unhandled API error',
    );
  });

  it('does not log when the handler returns normally', async () => {
    const handler = withErrorHandler(async () => respondOk({ fine: true }));

    const res = await handler(makeRequest('http://localhost/api/classes'));

    expect(res.status).toBe(200);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  /**
   * Bound to a const first, so the whole call fits on one line: TypeScript
   * reports the assignability error at the *argument's* position, and a
   * @ts-expect-error only suppresses errors on the line directly after it. An
   * inline multi-line arrow would put the error on a different line than the
   * directive, and the directive would read as unused.
   */
  const paramsFirstHandler = async (
    _ctx: { params: Promise<{ id: string }> },
    _req: Request,
  ): Promise<NextResponse> => respondOk({});

  // @ts-expect-error — args[0] must be the NextRequest. A params-first handler
  // is rejected by the constraint; if the generic is ever loosened back to
  // `unknown[]`, this line stops erroring and the unused directive becomes a
  // compile error itself. That inversion is the guard.
  withErrorHandler(paramsFirstHandler);
});

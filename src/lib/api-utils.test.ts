import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import type { SessionUser } from './types';
import type { CodedRefusal } from './api-error-codes';

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

// Real classification for every test except the one that overrides it with
// `mockReturnValueOnce` — the default implementation delegates to the actual
// `classifyApiError`, so this mock is transparent to every other
// `withErrorHandler` test in the file, which depend on real classification.
// The describe's `beforeEach` resets it back to that implementation, so the
// transparency does not depend on every override being consumed.
vi.mock('./api-errors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api-errors')>();
  return {
    ...actual,
    classifyApiError: vi.fn(actual.classifyApiError),
  };
});

import {
  respondOk,
  respondTyped,
  respondUnchanged,
  respondError,
  respondRefusal,
  requireSession,
  requireTeacher,
  requireStudent,
  parseBody,
  isErrorResponse,
  withErrorHandler,
} from './api-utils';
import { getSessionToken, validateSession } from './auth';
import { classifyApiError } from './api-errors';
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

describe('respondTyped', () => {
  interface SampleContract {
    id: string;
    count: number;
  }

  it('returns NextResponse with typed { data } body and correct status', async () => {
    const response = respondTyped<SampleContract>({ id: 'abc', count: 42 }, 201);

    expect(response).toBeInstanceOf(NextResponse);
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body).toEqual({ data: { id: 'abc', count: 42 } });
  });

  it('defaults to status 200', async () => {
    const response = respondTyped<{ ok: boolean }>({ ok: true });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ data: { ok: true } });
  });

  /**
   * The `@ts-expect-error` compile-time type assertions below are verified by
   * `npm run typecheck` only (`tsc --noEmit`) and are invisible to Vitest runtime
   * test execution (tests do not typecheck or transpile types).
   */
  it('enforces compile-time type requirements', () => {
    // Valid explicit call compiles clean
    const res = respondTyped<SampleContract>({ id: 'valid', count: 1 });
    expect(res.status).toBe(200);

    // @ts-expect-error — omitting <T> causes T to default to never, rejecting any payload
    respondTyped({ id: 'omitted-type-parameter' });

    // @ts-expect-error — missing required property 'count'
    respondTyped<SampleContract>({ id: 'missing-count' });

    // @ts-expect-error — 'count' must be number, not string
    respondTyped<SampleContract>({ id: 'wrong-type', count: '42' });

    // @ts-expect-error — fresh inline literal rejects excess property
    respondTyped<SampleContract>({ id: 'excess', count: 1, extra: true });
  });
});

describe('respondUnchanged', () => {
  it('answers 200 with the data and an unchanged outcome beside it', async () => {
    const response = respondUnchanged<{ id: string }>({ id: 'abc' });

    expect(response).toBeInstanceOf(NextResponse);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: 'abc' }, outcome: 'unchanged' });
  });

  it('enforces an explicit type argument, as respondTyped does', () => {
    const res = respondUnchanged<{ id: string }>({ id: 'valid' });
    expect(res.status).toBe(200);

    // @ts-expect-error — omitting <T> defaults T to never, rejecting any payload
    respondUnchanged({ id: 'omitted-type-parameter' });

    // @ts-expect-error — the payload must match T
    respondUnchanged<{ id: string }>({ id: 1 });
  });
});

/**
 * A refusal read off a `Record<Reason, CodedRefusal>` by a non-literal key —
 * the exact shape `TRANSITION_REFUSAL[result.reason]` has in
 * `src/app/api/classes/[id]/transition/route.ts`. `code`'s inferred type
 * here is the union `'NOT_FOUND' | 'PAYMENT_WAIVED'`, not either literal
 * alone — that's what the tests below exercise (#649).
 */
type SyntheticReason = 'gone' | 'waived';
const SYNTHETIC_REFUSAL = {
  gone: { code: 'NOT_FOUND', status: 404, message: 'A gone.' },
  waived: { code: 'PAYMENT_WAIVED', status: 409, message: 'B waived.' },
} as const satisfies Record<SyntheticReason, CodedRefusal>;

function pickSyntheticReason(): SyntheticReason {
  return 'gone';
}

describe('respondError', () => {
  it('returns NextResponse with { error: { message } } body and correct status', async () => {
    const response = respondError('Not found', 404);

    expect(response).toBeInstanceOf(NextResponse);
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toEqual({ error: { message: 'Not found', code: undefined } });
  });

  it('includes code when provided', async () => {
    const response = respondError('This class no longer exists.', 404, 'NOT_FOUND');

    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toEqual({
      error: { message: 'This class no longer exists.', code: 'NOT_FOUND' },
    });
  });

  /**
   * The `@ts-expect-error` lines are verified by `pnpm run typecheck` only.
   * Each is a guard: loosen the overloads and the directive it sits on
   * becomes unused, which is itself a compile error.
   */
  it('ties a code to its status, and a conflict to a code, at compile time', () => {
    expect(respondError('This class no longer exists.', 404, 'NOT_FOUND').status).toBe(404);
    expect(respondError('Teacher access required', 403).status).toBe(403);

    // @ts-expect-error — a 409 must carry a code
    respondError('A conflict with no code.', 409);

    // @ts-expect-error — NOT_FOUND is registered at 404, not 409
    respondError('Wrong status.', 409, 'NOT_FOUND');

    // @ts-expect-error — PAYMENT_WAIVED is registered at 409, not 404
    respondError('Wrong status.', 404, 'PAYMENT_WAIVED');

    // @ts-expect-error — not a registered code
    respondError('Unknown code.', 409, 'NOT_A_REGISTERED_CODE');

    // @ts-expect-error — a status the app never sends
    respondError('Teapot.', 418);

    const unionRefusal = SYNTHETIC_REFUSAL[pickSyntheticReason()];

    // @ts-expect-error — unionRefusal.code is a union (read from
    // SYNTHETIC_REFUSAL by a non-literal reason); a union-typed code must go
    // through respondRefusal, not a split status/code call (#649)
    respondError(unionRefusal.message, unionRefusal.status, unionRefusal.code);

    // @ts-expect-error — same union, even at a status that happens to match
    // one member: before #649 this compiled clean, because StatusOf<C> was
    // the union of every member's status (404 | 409), and 409 is assignable
    // to that union even though it is NOT_FOUND's wrong status
    respondError(unionRefusal.message, 409, unionRefusal.code);
  });
});

/**
 * The `@ts-expect-error` line is verified by `pnpm run typecheck` only, same
 * as `respondError`'s guard above.
 */
describe('respondRefusal', () => {
  it('sends a literal CodedRefusal exactly as given', async () => {
    const response = respondRefusal(SYNTHETIC_REFUSAL.gone);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { message: 'A gone.', code: 'NOT_FOUND' } });
  });

  it("accepts a refusal read from a union-typed index, and sends that member's own status", async () => {
    const refusal = SYNTHETIC_REFUSAL[pickSyntheticReason()];
    const response = respondRefusal(refusal);

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { message: 'A gone.', code: 'NOT_FOUND' } });
  });

  it("rejects a status/code pair that is not one of CodedRefusal's own members", () => {
    // @ts-expect-error — NOT_FOUND is registered at 404, not 409;
    // CodedRefusal is a distributed union of { code, status } pairs, so this
    // literal matches none of its members
    respondRefusal({ code: 'NOT_FOUND', status: 409, message: 'wrong' });
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

/**
 * The merge object of the first log call. Needed because `objectContaining`
 * compares an Error structurally: it cannot tell the thrown error from a
 * same-message replica, and the whole value of `err` is the real stack.
 */
function firstLoggedMerge(fn: typeof log.error): Record<string, unknown> {
  const call = vi.mocked(fn).mock.calls[0];
  return (call?.[0] ?? {}) as unknown as Record<string, unknown>;
}

describe('withErrorHandler', () => {
  beforeEach(() => {
    vi.mocked(log.error).mockClear();
    vi.mocked(log.warn).mockClear();
    // Also reset classifyApiError, which `mockReset` returns to the
    // delegating implementation it was constructed with. Clearing only the
    // log mocks would leave a `mockReturnValueOnce` that its own test failed
    // to consume queued for the next test, silently falsifying the claim at
    // the mock factory that this mock is transparent to every other test.
    vi.mocked(classifyApiError).mockReset();
  });

  it('logs the failing request method and path, then returns 500', async () => {
    const thrown = new Error('kaboom');
    const handler = withErrorHandler(async () => {
      throw thrown;
    });

    const res = await handler(
      makeRequest('http://localhost/api/classes/abc123/transition', { method: 'POST' }),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error' } });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/classes/abc123/transition',
      }),
      'unhandled API error',
    );
    // Identity, not `expect.any(Error)`: substituting a fresh Error loses the
    // operator's only stack trace and would satisfy a class-level assertion.
    expect(firstLoggedMerge(log.error)['err']).toBe(thrown);
  });

  /**
   * The bug this file's coverage was added for: the P2002 branch used to
   * return *above* the log line, so this 409 reached a teacher with no
   * server-side trace whatsoever.
   */
  it('logs an escaped P2002 at warn with its constraint, and still returns 409', async () => {
    const thrown = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['teacherId', 'roomId'] },
    });
    const handler = withErrorHandler(async () => {
      throw thrown;
    });

    const res = await handler(
      makeRequest('http://localhost/api/teacher-rooms', { method: 'POST' }),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { message: expect.any(String), code: 'UNIQUE_CONFLICT' },
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/teacher-rooms',
        target: ['teacherId', 'roomId'],
      }),
      expect.any(String),
    );
    expect(firstLoggedMerge(log.warn)['err']).toBe(thrown);
    expect(log.error).not.toHaveBeenCalled();
  });

  /**
   * Pins the spread order in the log call: `...failure.detail` must come
   * FIRST so the literal `err`/`method`/`path` keys win. Move the spread
   * below them and a classification's `detail` displaces the request context
   * this branch exists to guarantee — `err` included, which is why all three
   * are clobbered here rather than the two a partial reorder would leave.
   *
   * `ApiLogDetail` now rejects such a `detail` outright, hence the directive.
   * The two guards invert each other: relax the type and the directive goes
   * unused and `tsc` fails; move the spread and this assertion fails.
   *
   * The `@ts-expect-error` parameter check below is verified by `npm run typecheck`
   * only (`tsc --noEmit`) and is invisible to Vitest runtime test execution (tests do
   * not typecheck or transpile types).
   */
  it('keeps the real request context even when classifyApiError returns a clobbering detail', async () => {
    const thrown = new Error('kaboom');
    vi.mocked(classifyApiError).mockReturnValueOnce({
      status: 500,
      message: 'Internal server error',
      logMessage: 'unhandled API error',
      level: 'error',
      // @ts-expect-error — ApiLogDetail forbids exactly these keys.
      detail: { err: 'CLOBBERED', method: 'CLOBBERED', path: 'CLOBBERED' },
    });

    const handler = withErrorHandler(async () => {
      throw thrown;
    });

    await handler(
      makeRequest('http://localhost/api/classes/abc123/transition', { method: 'POST' }),
    );

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        path: '/api/classes/abc123/transition',
      }),
      'unhandled API error',
    );
    expect(firstLoggedMerge(log.error)['err']).toBe(thrown);
  });

  /**
   * `throw 'boom'` is legal JavaScript and reaches the wrapper as-is. Pino
   * logs a non-Error `err` verbatim but drops the key entirely when the value
   * is `undefined`, so the classification carries `thrownType` to keep the
   * line naming something whatever was thrown — including `throw undefined`,
   * which would otherwise log no error at all.
   */
  it('still names what was thrown when it is not an Error', async () => {
    const handler = withErrorHandler(async () => {
      throw 'boom';
    });

    const res = await handler(makeRequest('http://localhost/api/students', { method: 'GET' }));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { message: 'Internal server error' } });
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: 'boom',
        thrownType: 'string',
        method: 'GET',
        path: '/api/students',
      }),
      'unhandled API error',
    );
  });

  /**
   * Routes under src/app/api read searchParams. Logging nextUrl.href or
   * .search instead of .pathname would put every one of their query values in
   * the log; this pins the narrow choice so a future edit cannot widen it
   * quietly.
   */
  it('logs the path without the query string', async () => {
    const handler = withErrorHandler(async () => {
      throw new Error('kaboom');
    });

    await handler(
      makeRequest('http://localhost/api/students?archived=true&token=sensitive', {
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
   * The wrapper exists to stop stack traces leaking. If reading the request
   * could throw, a TypeError raised *inside* the catch would escape the
   * wrapper — strictly worse than the bug being fixed. TypeScript forbids
   * this call, so the cast simulates a JavaScript caller, which the types
   * cannot see. That caller is the only thing the optional chaining guards.
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
   *
   * This check is verified by `npm run typecheck` only (`tsc --noEmit`) and is
   * invisible to Vitest runtime test execution (tests do not typecheck or transpile types).
   */
  const paramsFirstHandler = async (
    _ctx: { params: Promise<{ id: string }> },
    _req: Request,
  ): Promise<NextResponse> => respondOk({});

  // @ts-expect-error — the first parameter must be the NextRequest. A
  // params-first handler is rejected by the signature; make the whole
  // parameter list generic again and this line stops erroring, turning the
  // unused directive into a compile error itself. That inversion is the guard.
  withErrorHandler(paramsFirstHandler);
});

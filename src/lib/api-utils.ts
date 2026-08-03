import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateSession, getSessionToken } from './auth';
import { prisma } from './db';
import { classifyApiError } from './api-errors';
import type { SessionUser, TeacherSession, StudentSession } from './types';
import { log } from '@/lib/log';

export function respondOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

export function respondError(
  message: string,
  status: number,
  code?: string
): NextResponse {
  return NextResponse.json({ error: { message, code } }, { status });
}

export async function requireSession(
  request: NextRequest
): Promise<SessionUser | NextResponse> {
  const token = getSessionToken(request);
  if (!token) return respondError('Authentication required', 401);
  const session = await validateSession(prisma, token);
  if (!session) return respondError('Session expired', 401);
  return session;
}

export async function requireTeacher(
  request: NextRequest
): Promise<TeacherSession | NextResponse> {
  const result = await requireSession(request);
  if (result instanceof NextResponse) return result;
  if (!result.teacherId)
    return respondError('Teacher access required', 403);
  return { ...result, teacherId: result.teacherId };
}

export async function requireStudent(
  request: NextRequest
): Promise<StudentSession | NextResponse> {
  const result = await requireSession(request);
  if (result instanceof NextResponse) return result;
  if (!result.studentId)
    return respondError('Student access required', 403);
  return { ...result, studentId: result.studentId };
}

export async function parseBody<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
): Promise<{ data: T } | { error: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { error: respondError('Invalid JSON', 400) };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    return { error: respondError(message, 400) };
  }

  return { data: result.data };
}

// Type guard helper for route handlers
export function isErrorResponse(
  result: SessionUser | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}

/**
 * Pick only the specified keys from an object, filtering out undefined values.
 * Used to allowlist fields on PUT endpoints to prevent mass assignment.
 */
export function pick<T extends Record<string, unknown>>(
  obj: T,
  keys: readonly string[],
): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result as Partial<T>;
}

/**
 * Wraps an API route handler in a try-catch to prevent unhandled exceptions
 * from leaking stack traces to the client.
 *
 * Exactly one log call and one response, both unconditional. Error-specific
 * behaviour lives in `classifyApiError` (src/lib/api-errors.ts), so adding a
 * case cannot skip the logger the way the old P2002 early return did (#121).
 *
 * `Args` is constrained rather than narrowed at runtime: every one of the 76
 * wrapped handlers takes the NextRequest first, so `args[0]` types without a
 * cast. The constraint rejects a params-first handler, but TypeScript still
 * accepts a zero-parameter one, and nothing stops a JavaScript caller — hence
 * the optional chaining. A TypeError thrown inside this catch would leak the
 * very stack trace the wrapper exists to contain.
 *
 * `path` is `nextUrl.pathname` only, never `search`/`href` — the privacy
 * guard against query strings (tokens, search terms) reaching the log. A
 * second, stronger reason: in Next's static-generation request proxies,
 * accessing `nextUrl.href`, `.search`, `.searchParams`, `.url`, `.origin`,
 * `toJSON`, or `toString` throws a `StaticGenBailoutError`, while `method`
 * and `pathname` are not in that throwing set. So logging `href` or `search`
 * here could throw inside this very catch block — the exact failure the
 * optional chaining above exists to prevent.
 */
export function withErrorHandler<Args extends [NextRequest, ...unknown[]]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (error) {
      const failure = classifyApiError(error);
      log[failure.level](
        {
          // `...failure.detail` spreads FIRST so the literal keys below always
          // win. #113 is queued to add classifyApiError cases returning
          // detail: { path } / { method } / { err } — a classification case
          // must never be able to displace the request context this wrapper
          // exists to guarantee.
          ...failure.detail,
          err: error,
          method: args[0]?.method,
          path: args[0]?.nextUrl?.pathname,
        },
        failure.logMessage,
      );
      return respondError(failure.message, failure.status);
    }
  };
}

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateSession, getSessionToken } from './auth';
import { prisma } from './db';
import { classifyApiError } from './api-errors';
import type { ApiErrorCode, ApiErrorStatus, CodedRefusal, CodeWithStatus } from './api-error-codes';
import type { SessionUser, TeacherSession, StudentSession } from './types';
import { log } from '@/lib/log';

/**
 * Checks nothing: `T` is inferred from whatever literal `data` happens to be,
 * so a dropped, extra, or mistyped field compiles clean. Prefer `respondTyped<T>`
 * below for a new response literal — it checks `data` against an explicit `T`.
 */
export function respondOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

/**
 * #206. A response helper whose payload literal is strictly checked against `T`.
 *
 * `T = never` ensures that omitting the type parameter (`respondTyped({...})`)
 * causes `data` to default to `never`, failing compilation with "Argument of
 * type ... is not assignable to parameter of type 'never'".
 *
 * When `<T>` is explicitly provided, `NoInfer<T>` prevents TypeScript from
 * inferring `T` from `data`, contextually typing and strictly checking the
 * object literal passed to `data` against `T`. Dropping a required field,
 * passing an incorrect type, or adding an excess property on an inline literal
 * becomes an immediate compile error.
 */
export function respondTyped<T = never>(data: NoInfer<T>, status = 200): NextResponse {
  return NextResponse.json({ data }, { status });
}

/**
 * The answer to a request whose goal already holds: 200, no write, no side
 * effect. `outcome` sits beside `data` rather than inside it, so a client that
 * reads `data` sees the same shape as for an applied request. Typed like
 * `respondTyped`: `T` must be given, and `data` is checked against it.
 */
export function respondUnchanged<T = never>(data: NoInfer<T>): NextResponse {
  return NextResponse.json({ data, outcome: 'unchanged' }, { status: 200 });
}

/** Every error status the app sends. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

/** True exactly when `T` is a union with more than one member (`A | B`, not `A`). */
type IsUnion<T, B = T> = T extends T ? ([B] extends [T] ? false : true) : never;

/**
 * A refusal. A code fixes its status (`src/lib/api-error-codes.ts`), so a code
 * sent at another status does not compile. `C` is inferred from `code` and
 * `S` from `status`; the call is only accepted when `S` is a single literal
 * status AND every member of `C` is registered at that exact status
 * (`[C] extends [CodeWithStatus<S>]`) — a union `code` is fine as long as it
 * provably shares one status with the literal passed (several existing call
 * sites already rely on this), but a union spanning more than one status is
 * a compile error regardless of which status literal is passed, because no
 * single literal can be correct for all its members. A 409 must name its
 * code, because a conflict is exactly what a client has to tell apart. A
 * refusal read off a `Record<Reason, CodedRefusal>` map — where each member
 * carries its OWN status, not one shared by every member — uses
 * `respondRefusal` instead, never this overload split into two arguments.
 * The rules are in `docs/technical-architecture.md` (The Services Layer →
 * Error responses).
 */
export function respondError<C extends ApiErrorCode, S extends ApiErrorStatus>(
  message: string,
  status: IsUnion<S> extends true ? never : ([C] extends [CodeWithStatus<S>] ? S : never),
  code: C,
): NextResponse;
export function respondError(message: string, status: Exclude<ErrorStatus, 409>): NextResponse;
export function respondError(
  message: string,
  status: ErrorStatus,
  code?: ApiErrorCode,
): NextResponse {
  return sendError(message, status, code);
}

/**
 * A refusal read whole off a `Record<Reason, CodedRefusal>` map (or any other
 * already-correlated `CodedRefusal` value) — never split into a `status` and
 * a `code` argument, which is what let a union-typed reason silently widen
 * `respondError`'s status check to every member's status at once (#649). The
 * pairing was already checked once, at the map's own
 * `satisfies Record<Reason, CodedRefusal>` — this only carries it to the
 * response.
 */
export function respondRefusal(refusal: CodedRefusal): NextResponse {
  return sendError(refusal.message, refusal.status, refusal.code);
}

function sendError(message: string, status: ErrorStatus, code?: ApiErrorCode): NextResponse {
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
 * The request is named positionally and only the trailing arguments are
 * generic. So `request` types as a NextRequest without a cast, and nothing a
 * handler declares can widen it: a params-first handler is rejected, and the
 * produced wrapper demands a NextRequest first even when the handler names no
 * parameters or types it as a plain `Request`. The optional chaining is
 * therefore not defending against TypeScript — it is defending against an
 * untyped JavaScript caller, which the types cannot see. A TypeError thrown
 * inside this catch would leak the very stack trace the wrapper exists to
 * contain.
 *
 * `path` is `nextUrl.pathname` only, never `search`/`href` — the privacy
 * guard against query strings (tokens, search terms) reaching the log.
 */
export function withErrorHandler<Rest extends unknown[]>(
  handler: (request: NextRequest, ...rest: Rest) => Promise<NextResponse>,
): (request: NextRequest, ...rest: Rest) => Promise<NextResponse> {
  return async (request: NextRequest, ...rest: Rest): Promise<NextResponse> => {
    try {
      return await handler(request, ...rest);
    } catch (error) {
      const failure = classifyApiError(error);
      log[failure.level](
        {
          // `...failure.detail` spreads FIRST so the literal keys below always
          // win: a classification's `detail` must never be able to displace
          // the request context this wrapper guarantees on every error.
          ...failure.detail,
          err: error,
          method: request?.method,
          path: request?.nextUrl?.pathname,
        },
        failure.logMessage,
      );
      return sendError(failure.message, failure.status, failure.code);
    }
  };
}

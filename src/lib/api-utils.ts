import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { validateSession, getSessionToken } from './auth';
import { prisma } from './db';
import type { SessionUser } from './types';

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
): Promise<SessionUser | NextResponse> {
  const result = await requireSession(request);
  if (result instanceof NextResponse) return result;
  if (result.userType !== 'teacher')
    return respondError('Teacher access required', 403);
  return result;
}

export async function requireStudent(
  request: NextRequest
): Promise<SessionUser | NextResponse> {
  const result = await requireSession(request);
  if (result instanceof NextResponse) return result;
  if (result.userType !== 'student')
    return respondError('Student access required', 403);
  return result;
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
 */
export function withErrorHandler<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (error) {
      console.error('API error:', error);
      return respondError('Internal server error', 500);
    }
  };
}

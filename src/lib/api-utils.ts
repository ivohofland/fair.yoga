import { NextRequest, NextResponse } from 'next/server';
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

export async function parseBody<T>(request: NextRequest): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

// Type guard helper for route handlers
export function isErrorResponse(
  result: SessionUser | NextResponse
): result is NextResponse {
  return result instanceof NextResponse;
}

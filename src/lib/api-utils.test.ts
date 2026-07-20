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

import {
  respondOk,
  respondError,
  requireSession,
  requireTeacher,
  requireStudent,
  parseBody,
  isErrorResponse,
} from './api-utils';
import { getSessionToken, validateSession } from './auth';

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

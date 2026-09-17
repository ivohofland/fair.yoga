import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redirectNonStudent } from './student-guard';
import type { SessionUser } from '@/lib/types';

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect,
}));

const teacherSession: SessionUser = {
  sessionId: 'sess-1',
  accountId: 'acc-1',
  teacherId: 'teacher-1',
  studentId: null,
  defaultTimezone: 'America/New_York',
};

describe('redirectNonStudent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects a teacher session to /schedule', () => {
    redirectNonStudent(teacherSession);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/schedule');
  });

  it('redirects a teacher session to /schedule even when redirectPath is provided', () => {
    redirectNonStudent(teacherSession, '/account/privacy');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/schedule');
  });

  it('redirects unauthenticated session with valid redirectPath to login with encoded redirect', () => {
    redirectNonStudent(null, '/account/privacy');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login?redirect=%2Faccount%2Fprivacy');
  });

  it('redirects unauthenticated session with unsafe redirectPath to bare /login', () => {
    const unsafePaths = ['//evil.com', '/\\evil.com', 'https://evil.com'];
    for (const unsafePath of unsafePaths) {
      vi.clearAllMocks();
      redirectNonStudent(null, unsafePath);
      expect(redirect).toHaveBeenCalledTimes(1);
      expect(redirect).toHaveBeenCalledWith('/login');
    }
  });

  it('redirects unauthenticated session without redirectPath to bare /login', () => {
    redirectNonStudent(null);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login');
  });

  it('redirects unauthenticated session with null or empty redirectPath to bare /login', () => {
    redirectNonStudent(null, null);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login');

    vi.clearAllMocks();
    redirectNonStudent(null, '');
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('/login');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionUser } from '@/lib/types';
import { log } from '@/lib/log';
import { expectUnchanged } from '../../../../tests/api-assertions';

/**
 * #213 was this same race answering a 500 at `error` — a real defect, not
 * a routine loser. The level is the fix; this pins it.
 */
const deleteStudentAccount = vi.fn();
const deleteTeacherAccount = vi.fn();

vi.mock('@/services/gdpr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/gdpr')>();
  return {
    ...actual,
    deleteStudentAccount: (...args: unknown[]) => deleteStudentAccount(...args),
    deleteTeacherAccount: (...args: unknown[]) => deleteTeacherAccount(...args),
  };
});

let session: SessionUser;

vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireSession: async () => session };
});

const { DELETE } = await import('./route');

function del(): Promise<Response> {
  return DELETE(new NextRequest('http://localhost:3000/api/account', { method: 'DELETE' }));
}

const STUDENT_SESSION: SessionUser = {
  sessionId: 'sess-1',
  accountId: 'acct-1',
  teacherId: null,
  studentId: 'student-1',
};

const TEACHER_SESSION: SessionUser = {
  sessionId: 'sess-2',
  accountId: 'acct-2',
  teacherId: 'teacher-1',
  defaultTimezone: 'Europe/Amsterdam',
  studentId: null,
};

describe('DELETE /api/account — an already-erased half logs at info, not warn or error', () => {
  beforeEach(() => {
    deleteStudentAccount.mockReset();
    deleteTeacherAccount.mockReset();
  });

  it('logs the student half at info and answers unchanged', async () => {
    session = STUDENT_SESSION;
    deleteStudentAccount.mockResolvedValueOnce({ erased: false, reason: 'already-erased' });

    const info = vi.spyOn(log, 'info').mockImplementation(() => log);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const error = vi.spyOn(log, 'error').mockImplementation(() => log);
    try {
      const res = await del();

      expect(await expectUnchanged(res)).toEqual({ deleted: true });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ half: 'student' }),
        'account erasure: half already erased',
      );
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('logs the teacher half at info and answers unchanged', async () => {
    session = TEACHER_SESSION;
    deleteTeacherAccount.mockResolvedValueOnce({ erased: false, reason: 'already-erased' });

    const info = vi.spyOn(log, 'info').mockImplementation(() => log);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const error = vi.spyOn(log, 'error').mockImplementation(() => log);
    try {
      const res = await del();

      expect(await expectUnchanged(res)).toEqual({ deleted: true });
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ half: 'teacher' }),
        'account erasure: half already erased',
      );
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });
});

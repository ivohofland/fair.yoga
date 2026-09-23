import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
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

/**
 * Not reachable through `tests/integration/account-api.test.ts`: that tier
 * drives the app over HTTP in a separate `next dev` process, so it can inject
 * a real `55P03` by holding a row (as it does for `ERASURE_BUSY`) but cannot
 * inject a `P2024`/`P2028` into that process's Prisma client. `@/services/gdpr`
 * is mocked here instead, the same seam the already-erased suite above uses,
 * so both transient kinds are reachable directly.
 */
describe('DELETE /api/account — a transient failure logs at its kind\'s level', () => {
  beforeEach(() => {
    deleteStudentAccount.mockReset();
    deleteTeacherAccount.mockReset();
  });

  const KINDS = [
    { kind: 'tx_budget' as const, level: 'warn' as const, code: 'P2028' as const },
    { kind: 'pool_exhausted' as const, level: 'error' as const, code: 'P2024' as const },
  ];

  it.each(KINDS)('logs the student half at $level for a $kind failure', async ({ kind, level, code }) => {
    session = STUDENT_SESSION;
    const failure = new Prisma.PrismaClientKnownRequestError('transient', {
      code,
      clientVersion: Prisma.prismaVersion.client,
    });
    deleteStudentAccount.mockRejectedValueOnce(failure);

    const spy = vi.spyOn(log, level).mockImplementation(() => log);
    const otherLevel = level === 'warn' ? 'error' : 'warn';
    const other = vi.spyOn(log, otherLevel).mockImplementation(() => log);
    try {
      const res = await del();

      expect(res.status).toBe(503);
      expect(spy).toHaveBeenCalledWith(
        {
          err: failure,
          accountId: STUDENT_SESSION.accountId,
          transient: true,
          transientKind: kind,
        },
        'account erasure: student half failed',
      );
      expect(other).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      other.mockRestore();
    }
  });

  it.each(KINDS)('logs the teacher half at $level for a $kind failure', async ({ kind, level, code }) => {
    session = TEACHER_SESSION;
    const failure = new Prisma.PrismaClientKnownRequestError('transient', {
      code,
      clientVersion: Prisma.prismaVersion.client,
    });
    deleteTeacherAccount.mockRejectedValueOnce(failure);

    const spy = vi.spyOn(log, level).mockImplementation(() => log);
    const otherLevel = level === 'warn' ? 'error' : 'warn';
    const other = vi.spyOn(log, otherLevel).mockImplementation(() => log);
    try {
      const res = await del();

      expect(res.status).toBe(503);
      // `TEACHER_SESSION.studentId` is `null`, so `partial` is `false` and the
      // message is the teacher-only one, not the `partial account erasure` one.
      expect(spy).toHaveBeenCalledWith(
        {
          err: failure,
          accountId: TEACHER_SESSION.accountId,
          partial: false,
          transient: true,
          transientKind: kind,
        },
        'account erasure: teacher half failed',
      );
      expect(other).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      other.mockRestore();
    }
  });

  it('logs a non-transient student-half failure at error with transientKind null', async () => {
    session = STUDENT_SESSION;
    const failure = new Error('schema drift');
    deleteStudentAccount.mockRejectedValueOnce(failure);

    const error = vi.spyOn(log, 'error').mockImplementation(() => log);
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const res = await del();

      expect(res.status).toBe(500);
      expect(error).toHaveBeenCalledWith(
        {
          err: failure,
          accountId: STUDENT_SESSION.accountId,
          transient: false,
          transientKind: null,
        },
        'account erasure: student half failed',
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });
});

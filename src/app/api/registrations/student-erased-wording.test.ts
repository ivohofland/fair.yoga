import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import type { SessionUser } from '@/lib/types';

/**
 * `STUDENT_ERASED` is one code for two different wordings, chosen by
 * `isTeacher` in `route.ts`'s catch — nothing else distinguishes the arms, so
 * swapping them would still send the registered code and pass every
 * code-only assertion this task's other tests make.
 *
 * Mocked, as `[id]/route.test.ts` beside it is: `lockLiveStudent` is forced
 * to throw `StudentErasedError` directly. That is the only way to reach the
 * self-booking arm at all without racing a real erasure against a real
 * booking — `validateSession` excludes a `deletedAt`-set student when
 * resolving a session's live profile, so a self-booking request against an
 * already-erased student 401s at the session gate before the handler runs.
 *
 * The mocked `prisma` rows below use fixed placeholder ids rather than the
 * request's own `classId`/`studentId`: nothing on this path compares them,
 * and `vi.mock`'s factory cannot close over a module-scope `const` declared
 * below it.
 */
let session: SessionUser = {
  sessionId: 'sess-1',
  accountId: 'acct-1',
  teacherId: null,
  studentId: 'student-1',
};

vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireSession: async () => session };
});
vi.mock('@/lib/db-locks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db-locks')>();
  return {
    ...actual,
    lockLiveStudent: async (_tx: unknown, lockedId: string) => {
      throw new actual.StudentErasedError(lockedId);
    },
  };
});
vi.mock('@/lib/db', () => ({
  prisma: {
    student: {
      findUnique: async () => ({
        id: 'student-1',
        email: 's@test.local',
        incomeTier: 3,
        firstName: 'Stu',
      }),
    },
    teacherStudent: {
      findUnique: async () => ({ teacherId: 'teacher-1', studentId: 'student-1' }),
    },
    $transaction: async (cb: (tx: unknown) => unknown) => cb({}),
  },
}));

const { POST } = await import('./route');

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new NextRequest('http://localhost:3000/api/registrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/registrations — STUDENT_ERASED wording (#197)', () => {
  it('tells the student their own account was deleted', async () => {
    session = {
      sessionId: 'sess-1',
      accountId: 'acct-1',
      teacherId: null,
      studentId: 'student-1',
    };

    const res = await post({ classId: randomUUID() });

    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'STUDENT_ERASED', message: 'This account has been deleted.' });
  });

  it("tells the adding teacher the student's account no longer exists", async () => {
    session = {
      sessionId: 'sess-1',
      accountId: 'acct-1',
      teacherId: 'teacher-1',
      defaultTimezone: 'Europe/Amsterdam',
      studentId: null,
    };

    const res = await post({ classId: randomUUID(), studentId: randomUUID() });

    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error).toEqual({
      code: 'STUDENT_ERASED',
      message: "This student's account no longer exists.",
    });
  });
});

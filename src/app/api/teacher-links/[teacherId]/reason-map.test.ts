import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectApplied, expectRefusal } from '../../../../../tests/api-assertions';

/**
 * What each outcome of `unlinkTeacher` answers on the wire. The service is
 * mocked: its own behaviour, including the concurrent erasure that turns its
 * delete's `P2025` into `NOT_LINKED`, is pinned in
 * `src/services/invitations-lock-order.test.ts`.
 */
const unlink = vi.fn();

vi.mock('@/services/invitations', () => ({
  unlinkTeacher: (...args: unknown[]) => unlink(...args),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    account: { findUniqueOrThrow: async () => ({ email: 'student@test.local' }) },
  },
}));
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireStudent: async () => ({
      sessionId: 'session-1', accountId: 'acct-1', teacherId: null, studentId: 'student-1',
    }),
  };
});

const { DELETE } = await import('./route');

function unlinkRequest() {
  return DELETE(
    new NextRequest('http://localhost:3000/api/teacher-links/teacher-1', { method: 'DELETE' }),
    { params: Promise.resolve({ teacherId: 'teacher-1' }) },
  );
}

beforeEach(() => {
  unlink.mockReset();
});

describe('DELETE /api/teacher-links/[teacherId] — service outcome to response (#197)', () => {
  it('answers a removed link 200 with its teacher id', async () => {
    unlink.mockResolvedValueOnce({ ok: true });
    expect(await expectApplied(await unlinkRequest())).toEqual({ teacherId: 'teacher-1' });
  });

  it.each([
    ['NOT_LINKED', 'NOT_FOUND'],
    ['STUDENT_ERASED', 'STUDENT_ERASED'],
  ] as const)('answers %s with %s', async (reason, code) => {
    unlink.mockResolvedValueOnce({ ok: false, reason });
    await expectRefusal(await unlinkRequest(), code);
  });
});

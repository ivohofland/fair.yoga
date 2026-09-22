import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { expectApplied, expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';

/**
 * What each outcome of `acceptInvitation` and `declineInvitation` answers on
 * the wire. The services are mocked: their own behaviour is pinned in
 * `src/services/invitations.decline.test.ts` and
 * `src/services/invitations-lock-order.test.ts`. Mocking `@/lib/db` keeps
 * this file off the database entirely.
 */
const accept = vi.fn();
const decline = vi.fn();

vi.mock('@/services/invitations', () => ({
  acceptInvitation: (...args: unknown[]) => accept(...args),
  declineInvitation: (...args: unknown[]) => decline(...args),
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

const { POST } = await import('./route');

function respond(response: 'accept' | 'decline') {
  return POST(
    new NextRequest('http://localhost:3000/api/invitations/inv-1/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    }),
    { params: Promise.resolve({ id: 'inv-1' }) },
  );
}

beforeEach(() => {
  accept.mockReset();
  decline.mockReset();
});

describe('POST /api/invitations/[id]/respond — service outcome to response (#197)', () => {
  it('answers an applied accept 200 with no outcome', async () => {
    accept.mockResolvedValueOnce({ ok: true, outcome: 'applied' });
    expect(await expectApplied(await respond('accept'))).toEqual({ id: 'inv-1' });
  });

  it('answers an unchanged accept 200 unchanged', async () => {
    accept.mockResolvedValueOnce({ ok: true, outcome: 'unchanged' });
    expect(await expectUnchanged(await respond('accept'))).toEqual({ id: 'inv-1' });
  });

  it('answers an unchanged decline 200 unchanged', async () => {
    decline.mockResolvedValueOnce({ ok: true, outcome: 'unchanged' });
    expect(await expectUnchanged(await respond('decline'))).toEqual({ id: 'inv-1' });
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['NOT_PENDING', 'ALREADY_ANSWERED'],
    ['CONCURRENT_MODIFICATION', 'CONCURRENT_MODIFICATION'],
    ['STUDENT_ERASED', 'STUDENT_ERASED'],
  ] as const)('answers an accept refused %s with %s', async (reason, code) => {
    accept.mockResolvedValueOnce({ ok: false, reason });
    await expectRefusal(await respond('accept'), code);
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['NOT_PENDING', 'ALREADY_ANSWERED'],
    ['CONCURRENT_MODIFICATION', 'CONCURRENT_MODIFICATION'],
  ] as const)('answers a decline refused %s with %s', async (reason, code) => {
    decline.mockResolvedValueOnce({ ok: false, reason });
    await expectRefusal(await respond('decline'), code);
  });
});

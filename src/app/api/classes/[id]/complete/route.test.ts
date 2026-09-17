import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import { expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';

/**
 * How `POST /api/classes/[id]/complete` answers each result `completeClass`
 * can return, with the service mocked. The race that makes the unchanged
 * answer matter is staged against a real database in
 * `route-lock-order.test.ts` beside this file.
 */
const completeClass = vi.fn();
const findUniqueClass = vi.fn();

vi.mock('@/services/class-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-lifecycle')>();
  return { ...actual, completeClass: (...args: unknown[]) => completeClass(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique: (...args: unknown[]) => findUniqueClass(...args) } },
}));

const { POST } = await import('./route');

const CLASS_ID = '0b8d4a0e-5d0f-4c3e-8f55-2a7b9c1d3e40';

function complete(): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost:3000/api/classes/${CLASS_ID}/complete`, { method: 'POST' }),
    { params: Promise.resolve({ id: CLASS_ID }) },
  );
}

async function messageOf(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json()) as { error?: { message?: string } };
  return body.error?.message;
}

describe('POST /api/classes/[id]/complete — each service result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueClass.mockResolvedValue({ id: CLASS_ID, calendarEntry: { teacherId: 'teacher-1' } });
  });

  it('answers NOT_FOUND when the class is gone before the handler reads it', async () => {
    findUniqueClass.mockResolvedValueOnce(null);

    await expectRefusal(await complete(), 'NOT_FOUND');
    expect(completeClass).not.toHaveBeenCalled();
  });

  it('answers an already-completed class as unchanged, in the applied shape', async () => {
    completeClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'completed', to: 'completed',
    });

    expect(await expectUnchanged(await complete())).toEqual({ ok: true, newStatus: 'completed' });
  });

  it('words a draft by its own pair', async () => {
    completeClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'draft', to: 'completed',
    });

    const res = await complete();

    expect(await messageOf(res)).toBe(transitionRefusalMessage('draft', 'completed'));
    await expectRefusal(res, 'ILLEGAL_TRANSITION');
  });

  // NOT_FOUND was a 409 before: the route sent every refusal at one status.
  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['CANCELLED', 'CLASS_CANCELLED'],
    ['NOT_ENDED_YET', 'CLASS_NOT_ENDED_YET'],
  ] as const)('answers %s with %s', async (reason, code) => {
    completeClass.mockResolvedValueOnce({ ok: false, reason, error: 'service words' });

    await expectRefusal(await complete(), code);
  });
});

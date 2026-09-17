import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { transitionRefusalMessage } from '@/lib/transition-refusal';
import { expectRefusal, expectUnchanged } from '../../../../../../tests/api-assertions';

/**
 * How `POST /api/classes/[id]/transition` answers each result
 * `transitionClass` can return. The service is mocked, so every reason is
 * reached directly, including the ones no database state reaches through this
 * route.
 */
const transitionClass = vi.fn();
const findUniqueClass = vi.fn();

vi.mock('@/services/class-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-lifecycle')>();
  return { ...actual, transitionClass: (...args: unknown[]) => transitionClass(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique: (...args: unknown[]) => findUniqueClass(...args) } },
}));

const { POST } = await import('./route');

const CLASS_ID = '6f1c1a52-3a55-4d6e-9d2b-8c1f0b7e2a10';

function transition(status: string): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost:3000/api/classes/${CLASS_ID}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
    { params: Promise.resolve({ id: CLASS_ID }) },
  );
}

/** Read from a clone, so `expectRefusal` can still read the body. */
async function messageOf(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json()) as { error?: { message?: string } };
  return body.error?.message;
}

describe('POST /api/classes/[id]/transition — each service result', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueClass.mockResolvedValue({ id: CLASS_ID, calendarEntry: { teacherId: 'teacher-1' } });
  });

  it('answers NOT_FOUND when the class is gone before the handler reads it', async () => {
    findUniqueClass.mockResolvedValueOnce(null);

    await expectRefusal(await transition('open'), 'NOT_FOUND');
    expect(transitionClass).not.toHaveBeenCalled();
  });

  it('answers a request for the status the class holds as unchanged, in the applied shape', async () => {
    transitionClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'open', to: 'open',
    });

    expect(await expectUnchanged(await transition('open'))).toEqual({ ok: true, newStatus: 'open' });
  });

  it('words an illegal pair by its own from and to', async () => {
    transitionClass.mockResolvedValueOnce({
      ok: false, reason: 'ILLEGAL_TRANSITION', error: 'service words', from: 'open', to: 'draft',
    });

    const res = await transition('draft');

    expect(await messageOf(res)).toBe(transitionRefusalMessage('open', 'draft'));
    await expectRefusal(res, 'ILLEGAL_TRANSITION');
  });

  it.each([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['CANCELLED', 'CLASS_CANCELLED'],
    ['CONCURRENT_MODIFICATION', 'CONCURRENT_MODIFICATION'],
    ['STARTS_IN_PAST', 'CLASS_STARTS_IN_PAST'],
    ['ROOM_ARCHIVED', 'ROOM_ARCHIVED'],
    ['NOT_ENDED_YET', 'CLASS_NOT_ENDED_YET'],
  ] as const)('answers %s with %s', async (reason, code) => {
    transitionClass.mockResolvedValueOnce({ ok: false, reason, error: 'service words' });

    await expectRefusal(await transition('open'), code);
  });
});

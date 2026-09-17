import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { log } from '@/lib/log';
import { frozenClassMessage } from '@/lib/transition-refusal';
import { expectRefusal } from '../../../../../tests/api-assertions';

/**
 * How `PUT /api/classes/[id]` answers `updateClass`'s refusals, with the
 * service mocked. The copy comparison is against the function the route calls,
 * so it pins which state the route passed on, not the wording.
 */
const updateClass = vi.fn();
const findUniqueClass = vi.fn();

vi.mock('@/services/class-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/class-lifecycle')>();
  return { ...actual, updateClass: (...args: unknown[]) => updateClass(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return { ...actual, requireTeacher: async () => ({ teacherId: 'teacher-1', accountId: 'acct-1' }) };
});
vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique: (...args: unknown[]) => findUniqueClass(...args) } },
}));

const { PUT } = await import('./route');

const CLASS_ID = '3c9e7b1a-2d4f-4a6b-8c0d-1e2f3a4b5c6d';

const OWNED_CLASS = {
  id: CLASS_ID,
  calendarEntryId: 'entry-1',
  calendarEntry: {
    teacherId: 'teacher-1',
    date: new Date('2099-06-01T00:00:00.000Z'),
    startTime: new Date('1970-01-01T09:00:00.000Z'),
    durationMinutes: 60,
  },
};

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(
    new NextRequest(`http://localhost:3000/api/classes/${CLASS_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: CLASS_ID }) },
  );
}

async function messageOf(res: Response): Promise<string | undefined> {
  const body = (await res.clone().json()) as { error?: { message?: string } };
  return body.error?.message;
}

describe('PUT /api/classes/[id] — refusals', () => {
  beforeEach(() => {
    // `mockReset`, not `clearAllMocks`: the latter leaves a queued
    // `mockResolvedValueOnce` in place for the next case to consume.
    updateClass.mockReset();
    findUniqueClass.mockReset();
    findUniqueClass.mockResolvedValue(OWNED_CLASS);
  });

  it('answers NOT_FOUND when the class is gone before the handler reads it', async () => {
    findUniqueClass.mockResolvedValueOnce(null);

    await expectRefusal(await put({ description: 'x' }), 'NOT_FOUND');
    expect(updateClass).not.toHaveBeenCalled();
  });

  it('answers NOT_FOUND when the service finds the class gone', async () => {
    updateClass.mockResolvedValueOnce({ ok: false, reason: 'not_found' });

    await expectRefusal(await put({ description: 'x' }), 'NOT_FOUND');
  });

  it('answers a locked economic edit with SETTINGS_LOCKED', async () => {
    updateClass.mockResolvedValueOnce({ ok: false, reason: 'locked', fields: ['roomCost'] });

    await expectRefusal(await put({ roomCost: 1 }), 'SETTINGS_LOCKED');
  });

  /**
   * #72's invariant, on this side of the seam: the refusal names every
   * economic field the request sent, in the order the service tuple carries
   * them, and never an empty list. `toEqual` on the array rather than a
   * membership check, because a route that sorted or truncated the tuple would
   * satisfy anything weaker. What the service puts in that tuple is
   * `class-lifecycle.test.ts`'s, over the real function.
   */
  it('logs the whole field tuple the service handed it, in that order', async () => {
    updateClass.mockResolvedValueOnce({
      ok: false,
      reason: 'locked',
      fields: ['roomCost', 'minRate'],
    });
    const info = vi.spyOn(log, 'info').mockImplementation(() => log);
    try {
      await expectRefusal(await put({ minRate: 1, roomCost: 999 }), 'SETTINGS_LOCKED');

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          classId: CLASS_ID,
          teacherId: 'teacher-1',
          fields: ['roomCost', 'minRate'],
        }),
        'class edit refused: its economics are locked',
      );
    } finally {
      info.mockRestore();
    }
  });

  it.each(['completed', 'cancelled'] as const)(
    'answers a %s class with CLASS_TERMINAL, in that state’s words',
    async (state) => {
      updateClass.mockResolvedValueOnce({ ok: false, reason: 'terminal', state });

      const res = await put({ date: '2020-01-01' });

      expect(await messageOf(res)).toBe(frozenClassMessage(state));
      await expectRefusal(res, 'CLASS_TERMINAL');
    },
  );
});

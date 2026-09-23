import { describe, it, vi, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { WaitlistPromotionError } from '@/services/waitlist';
import { expectRefusal } from '../../../../../tests/api-assertions';

/**
 * `POST /api/waitlist/claim`'s `window_frozen` branch. An HTTP fixture
 * cannot hold a class `open` past its start without racing the live
 * scheduler (`tests/integration/waitlist-api.test.ts` no longer tries), so
 * this mocks `claimSpot` to throw and asserts the route's own
 * reason-to-code mapping, in the style of
 * `api/registrations/[id]/promote-after-cancel.test.ts`.
 */

const claimSpot = vi.fn();

vi.mock('@/services/waitlist', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/waitlist')>();
  // Everything but `claimSpot` stays real — `WaitlistPromotionError`
  // especially, since the route's `instanceof` check has to see the same
  // class this test throws.
  return { ...actual, claimSpot: (...args: unknown[]) => claimSpot(...args) };
});
vi.mock('@/lib/api-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api-utils')>();
  return {
    ...actual,
    requireSession: async () => ({
      sessionId: 'sess-1',
      accountId: 'acct-1',
      teacherId: null,
      studentId: 'student-1',
    }),
  };
});

const { POST } = await import('./route');

function claim(): NextRequest {
  return new NextRequest('http://localhost:3000/api/waitlist/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ classId: randomUUID() }),
  });
}

describe('POST /api/waitlist/claim — the frozen window', () => {
  it('answers WAITLIST_FROZEN when claimSpot reports window_frozen', async () => {
    claimSpot.mockRejectedValueOnce(
      new WaitlistPromotionError(
        'The class has started, so spots can no longer be claimed.',
        'window_frozen',
      ),
    );
    onTestFinished(() => {
      claimSpot.mockReset();
    });

    const res = await POST(claim());

    await expectRefusal(res, 'WAITLIST_FROZEN');
  });
});

import { describe, it, expect } from 'vitest';
import { LIVE_REFUND_STATUSES, refundEndedAtMollie, refundIsFinal, refundIsLive } from './processor-refund-status';

describe('refund status groupings', () => {
  it('lists the live statuses', () => {
    expect([...LIVE_REFUND_STATUSES].sort()).toEqual(['pending', 'processing', 'queued']);
  });

  it.each([
    ['queued', true, false, false],
    ['pending', true, false, false],
    ['processing', true, false, false],
    ['refunded', false, true, false],
    ['failed', false, true, true],
    ['canceled', false, true, true],
  ] as const)('%s: live %s, final %s, ended at Mollie %s', (status, live, final, ended) => {
    expect(refundIsLive(status)).toBe(live);
    expect(refundIsFinal(status)).toBe(final);
    expect(refundEndedAtMollie(status)).toBe(ended);
  });
});

import { describe, it, expect } from 'vitest';
import { CLAIMABLE_WAITLIST_STATUSES } from './waitlist-status';

/**
 * These assertions exist because the set they describe was, until #216's
 * whole-branch review, spelled three different ways in three files and agreed
 * only in prose. It did not agree, and a queued student walked in at the door
 * ended up with a live billed registration beside an entry stuck on `expired`.
 *
 * The exhaustiveness pin lives in the `Record<WaitlistStatus, …>` in the module
 * itself — a sixth enum member is a compile error there, which no runtime test
 * can express. What these hold is the two decisions that `Record` cannot: which
 * roles count as claimable, and the one exclusion that is legally load-bearing.
 */
describe('CLAIMABLE_WAITLIST_STATUSES', () => {
  it('is exactly the two statuses a walk-in can resolve', () => {
    expect([...CLAIMABLE_WAITLIST_STATUSES].sort()).toEqual(['expired', 'waiting']);
  });

  /**
   * The exclusion, held separately from the membership assertion above because
   * it is the one that carries a consequence rather than a convention.
   *
   * `removed` means the student left, or a cancel path closed the queue (#195)
   * — a decision already made about them. Resolving that to `claimed` would
   * assert the opposite of what happened, and `exportStudentData` publishes the
   * status verbatim in an Article 15 export.
   */
  it('excludes removed, promoted and claimed', () => {
    expect(CLAIMABLE_WAITLIST_STATUSES).not.toContain('removed');
    expect(CLAIMABLE_WAITLIST_STATUSES).not.toContain('promoted');
    expect(CLAIMABLE_WAITLIST_STATUSES).not.toContain('claimed');
  });

  it('is frozen, so no call site can widen what a walk-in may consume', () => {
    expect(Object.isFrozen(CLAIMABLE_WAITLIST_STATUSES)).toBe(true);
  });
});

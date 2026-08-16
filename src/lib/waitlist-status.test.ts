import { describe, it, expect } from 'vitest';
import { CLAIMABLE_WAITLIST_STATUSES, FULFILLED_WAITLIST_STATUSES } from './waitlist-status';

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

/**
 * The same two assertions its sibling above has, for the set that gates a
 * PERMANENT DELETE.
 *
 * `waitlist-retention.ts` (#238) uses this as one of its two discriminators for
 * "this entry never became a booking", so a member silently leaving this set
 * makes rows reapable that must not be. That is the direction with no undo, and
 * until now nothing here asserted membership at all — both members are derived
 * from `QUEUE_ROLE`, and moving one to a different role changed the reaper's
 * behaviour with no test in this file to notice.
 *
 * `waitlist-retention.test.ts` iterates this constant to prove each member is
 * actually protected; these two say WHICH members that iteration should cover,
 * so a set that quietly emptied could not make the iteration pass vacuously.
 */
describe('FULFILLED_WAITLIST_STATUSES', () => {
  it('is exactly the two statuses that mean the student got a seat', () => {
    expect([...FULFILLED_WAITLIST_STATUSES].sort()).toEqual(['claimed', 'promoted']);
  });

  it('is frozen, so no call site can narrow what the reaper must keep', () => {
    expect(Object.isFrozen(FULFILLED_WAITLIST_STATUSES)).toBe(true);
  });
});

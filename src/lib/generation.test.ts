import { describe, it, expect } from 'vitest';
import { anyBlocked, countSkipReasons, type SkipCounts, type SkippedSlot } from './generation';

const at = (iso: string, reason: SkippedSlot['reason']): SkippedSlot => ({
  date: new Date(iso),
  reason,
});

const NONE: SkipCounts = {
  blockedByCancelled: 0,
  slotTaken: 0,
  alreadyThisWeek: 0,
  blockedByOverlap: 0,
};

/**
 * PR #300 review. `anyBlocked` was added to fix the two create gates and had no
 * direct test — it was exercised only through the two form tests, each with a
 * single non-zero member. A revert to the old hand-listed pair would have been
 * caught, but nothing pinned the per-member behaviour the function exists for.
 */
describe('anyBlocked', () => {
  it('is false when the window came back whole', () => {
    expect(anyBlocked(NONE)).toBe(false);
  });

  it('is true for ANY single non-zero member, one case per member', () => {
    // Looped over the object's own keys rather than a hand-written list, so a
    // fifth `SkipCounts` member is covered here the moment it is declared —
    // which is the property the function was written for, tested the same way
    // the function works.
    for (const key of Object.keys(NONE) as (keyof SkipCounts)[]) {
      expect(anyBlocked({ ...NONE, [key]: 1 }), key).toBe(true);
    }
  });

  it('ignores a negative count rather than reading it as blocked', () => {
    // `> 0`, not `!== 0`. `countSkipReasons` only increments, so no SERVER
    // producer emits a negative — but that is not where `anyBlocked` gets its
    // input. Both production callers read it from `res.json()` under a bare
    // annotation, and `template-action-messages.ts`'s guard docblock states
    // the rule: "the type constrains the SERVER and nothing constrains the
    // WIRE." So a negative is representable at this function's actual
    // boundary, and this pins a behaviour there rather than merely pinning a
    // comparison. It is also the case a `!== 0` "simplification" would flip.
    expect(anyBlocked({ ...NONE, slotTaken: -1 })).toBe(false);
  });
});

describe('countSkipReasons', () => {
  it('counts the four reasons a teacher is shown, and ignores the two they are not', () => {
    const counts = countSkipReasons([
      at('2026-09-21T00:00:00.000Z', 'blocked_by_cancelled'),
      at('2026-09-28T00:00:00.000Z', 'slot_taken'),
      at('2026-10-05T00:00:00.000Z', 'already_this_week'),
      at('2026-10-12T00:00:00.000Z', 'already_this_week'),
      at('2026-11-02T00:00:00.000Z', 'blocked_by_overlap'),
      // Deliberately excluded — see SkipCounts' docblock.
      at('2026-10-19T00:00:00.000Z', 'already_generated'),
      at('2026-10-26T00:00:00.000Z', 'raced'),
    ]);

    expect(counts).toEqual({
      blockedByCancelled: 1,
      slotTaken: 1,
      alreadyThisWeek: 2,
      blockedByOverlap: 1,
    });
  });

  /**
   * `blocked_by_overlap` and `slot_taken` are separate members carrying
   * separate remedies (#296), and the one way to prove they have not been
   * conflated is to count both at once at DIFFERENT values. Equal values pass
   * against a filter wired to the wrong member — the coincidence
   * `class-template-lifecycle.test.ts` already records paying for once.
   */
  it('counts blocked_by_overlap apart from slot_taken', () => {
    const counts = countSkipReasons([
      at('2026-09-21T00:00:00.000Z', 'blocked_by_overlap'),
      at('2026-09-28T00:00:00.000Z', 'blocked_by_overlap'),
      at('2026-10-05T00:00:00.000Z', 'blocked_by_overlap'),
      at('2026-10-12T00:00:00.000Z', 'slot_taken'),
    ]);

    expect(counts.blockedByOverlap).toBe(3);
    expect(counts.slotTaken).toBe(1);
  });

  it('returns zeroes for an empty skip list', () => {
    expect(countSkipReasons([])).toEqual({
      blockedByCancelled: 0,
      slotTaken: 0,
      alreadyThisWeek: 0,
      blockedByOverlap: 0,
    });
  });
});

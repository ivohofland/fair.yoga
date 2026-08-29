import { describe, it, expect } from 'vitest';
import {
  anyBlocked,
  countSkipReasons,
  spansOverlap,
  type SkipCounts,
  type SkippedSlot,
} from './generation';

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

/**
 * `spansOverlap`'s HALF-OPEN BOUNDARY, which nothing pinned.
 *
 * Non-exact-start overlap is pinned behaviourally by both families' generator
 * suites, but every fixture there overlaps by a comfortable margin — no live
 * entry sits exactly back-to-back with a candidate. So mutating `<` to `<=`
 * survived the whole tree, and that mutation makes the generator skip dates
 * `CalendarEntry_teacher_slot_excl` would have ADMITTED: a pre-check STRICTER
 * than the guard it mirrors, which the stage B spec §4.1 calls the only real
 * defect, because a window silently comes back short and nothing raises.
 *
 * Two assertions close it, one on each end, because `<=` on either comparison
 * alone is a mutation and the two ends are different comparisons.
 *
 * `@db.Time` values arrive as `Date`s pinned to 1970-01-01 UTC, which is what
 * these fixtures are — the function reads them with UTC accessors for exactly
 * that reason, and a local-accessor mutation would move every one of these by
 * the suite's `TZ=America/New_York` offset.
 */
describe('spansOverlap', () => {
  const span = (hhmm: string, durationMinutes: number) => ({
    startTime: new Date(`1970-01-01T${hhmm}:00.000Z`),
    durationMinutes,
  });

  // 09:00-10:00 then 10:00-11:00. `[)` on both sides: the first ends where the
  // second begins, and the constraint admits the pair (`calendar-entry.test.ts`
  // measures that against the real database). `<=` for the FIRST comparison
  // makes this true and the pre-check refuses a date PostgreSQL would take.
  it('is false for two spans that touch, in either argument order', () => {
    expect(spansOverlap(span('09:00', 60), span('10:00', 60))).toBe(false);
    expect(spansOverlap(span('10:00', 60), span('09:00', 60))).toBe(false);
  });

  // One minute over the same boundary, in both directions, which is what stops
  // a mutation that simply returns `false` from satisfying the case above.
  it('is true one minute inside that boundary, in either argument order', () => {
    expect(spansOverlap(span('09:00', 61), span('10:00', 60))).toBe(true);
    expect(spansOverlap(span('10:00', 60), span('09:00', 61))).toBe(true);
  });
});

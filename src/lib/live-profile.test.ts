import { describe, it, expect } from 'vitest';
import { liveProfile } from './live-profile';

describe('liveProfile', () => {
  it('returns null when the account holds no live profile of this kind', () => {
    expect(liveProfile([])).toBeNull();
  });

  it('returns the only live profile', () => {
    expect(liveProfile([{ id: 'only', deletedAt: null }])).toEqual({ id: 'only', deletedAt: null });
  });

  // The point of the throw: a caller that took `[0]` would pick one of these
  // silently. Asserting the message, not just that it threw, keeps this
  // discriminating if the guard is ever loosened to a warning.
  it('throws rather than choosing between two live profiles', () => {
    expect(() =>
      liveProfile([
        { id: 'a', deletedAt: null },
        { id: 'b', deletedAt: null },
      ]),
    ).toThrow(/account holds more than one live profile of a kind: a, b/);
  });

  // The defect this change closes: a caller whose select omits
  // `where: { deletedAt: null }` used to hand back the tombstone here with no
  // throw and no log, because `liveProfile` could not see `deletedAt` at all.
  it('returns null for a lone soft-deleted row, not the row itself', () => {
    expect(liveProfile([{ id: 'erased', deletedAt: new Date() }])).toBeNull();
  });

  it('ignores soft-deleted rows when a live one is also present', () => {
    expect(
      liveProfile([
        { id: 'erased', deletedAt: new Date() },
        { id: 'live', deletedAt: null },
      ]),
    ).toEqual({ id: 'live', deletedAt: null });
  });
});

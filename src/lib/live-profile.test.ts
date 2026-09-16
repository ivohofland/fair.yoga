import { describe, it, expect } from 'vitest';
import { liveProfile } from './live-profile';

describe('liveProfile', () => {
  it('returns null when the account holds no live profile of this kind', () => {
    expect(liveProfile([])).toBeNull();
  });

  it('returns the only live profile', () => {
    expect(liveProfile([{ id: 'only' }])).toEqual({ id: 'only' });
  });

  // The partial unique index makes two live rows unreachable. This asserts
  // what happens if it is ever absent: a loud throw, not an arbitrary pick.
  // Two of the five call sites can be handed a tombstone by an arbitrary
  // pick, which is why silence is the wrong default here.
  it('throws rather than choosing between two live profiles', () => {
    expect(() => liveProfile([{ id: 'a' }, { id: 'b' }])).toThrow(
      /account holds 2 live profiles/,
    );
  });
});

import { describe, it, expect } from 'vitest';
import { liveProfile } from './live-profile';

describe('liveProfile', () => {
  it('returns null when the account holds no live profile of this kind', () => {
    expect(liveProfile([])).toBeNull();
  });

  it('returns the only live profile', () => {
    expect(liveProfile([{ id: 'only' }])).toEqual({ id: 'only' });
  });

  // The point of the throw: a caller that took `[0]` would pick one of these
  // silently. Asserting the message, not just that it threw, keeps this
  // discriminating if the guard is ever loosened to a warning.
  it('throws rather than choosing between two live profiles', () => {
    expect(() => liveProfile([{ id: 'a' }, { id: 'b' }])).toThrow(
      /account holds 2 live profiles/,
    );
  });
});

import { describe, it, expect } from 'vitest';
import { erasedAddress, isErasedAddress } from './erased-address';

describe('erased addresses', () => {
  it('recognises what it builds', () => {
    expect(isErasedAddress(erasedAddress('3f2a'))).toBe(true);
  });

  it('builds the lowercase form the email CHECK constraints require', () => {
    const built = erasedAddress('ABC');
    expect(built).toBe(built.toLowerCase());
  });

  it('does not recognise an ordinary address, or one merely containing the domain', () => {
    expect(isErasedAddress('anna@example.com')).toBe(false);
    expect(isErasedAddress('deleted.invalid@example.com')).toBe(false);
    // Ends with the domain's characters but with no `@` delimiter before
    // them — not the shape erasure writes.
    expect(isErasedAddress('notreallydeleted.invalid')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { isValidTimeZone } from './iana-timezone';

describe('isValidTimeZone', () => {
  it('accepts a current IANA identifier', () => {
    expect(isValidTimeZone('Europe/Amsterdam')).toBe(true);
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  /**
   * The construct-probe accepts aliases, and that is the point: it must accept
   * exactly what `classStartInstant` can interpret, not the narrower set
   * `Intl.supportedValuesOf` happens to enumerate. Measured 2026-09-01 on Node
   * v22.22.2 (full ICU): ICU ships IANA's `backward` links, so every one of
   * these still resolves.
   */
  it('accepts renamed and deprecated identifiers, because Intl still resolves them', () => {
    for (const alias of ['Europe/Kiev', 'Asia/Calcutta', 'US/Eastern', 'CET']) {
      expect(isValidTimeZone(alias)).toBe(true);
    }
  });

  it('rejects an identifier Intl cannot resolve', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  /**
   * `Invalid/` is not one of IANA's ten areas (Africa, America, Antarctica,
   * Arctic, Asia, Atlantic, Australia, Europe, Indian, Pacific), so this
   * sentinel can never become valid under a future tzdata release. Re-derive
   * the area list with:
   *   [...new Set(Intl.supportedValuesOf('timeZone').map(z => z.split('/')[0]))]
   */
  it('rejects the reserved test sentinel, which no tzdata release can make valid', () => {
    expect(isValidTimeZone('Invalid/Test_Zone_145')).toBe(false);
  });
});

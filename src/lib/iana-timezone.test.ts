import { describe, it, expect } from 'vitest';
import { isValidTimeZone, modernTimeZone, MODERN_ZONE_NAMES } from './iana-timezone';

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

  /**
   * Real IANA zones only: offset identifiers resolve in Intl, and the probe
   * refuses them because `cancelCandidateDates` relies on the IANA offset
   * range. `−18:00` (written `−` below) starts with U+2212 MINUS SIGN, not an ASCII sign; Intl
   * resolves it to `-18:00`, so only the resolved-name check refuses it.
   */
  it('rejects offset identifiers, which Intl resolves but no IANA zone is', () => {
    for (const offset of ['+18:00', '-23:59', '+14:00', '+2359', '+18', '−18:00']) {
      expect(isValidTimeZone(offset)).toBe(false);
    }
  });

  it('accepts the IANA zones at both ends of the offset range', () => {
    for (const zone of ['Etc/GMT+12', 'Etc/GMT-14', 'Pacific/Kiritimati', 'Europe/Amsterdam', 'UTC']) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });
});

const resolve = (tz: string): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;

describe('modernTimeZone', () => {
  it('renames an old spelling to its current IANA name', () => {
    expect(modernTimeZone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(modernTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(modernTimeZone('America/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
  });

  it('returns every other zone unchanged, including valid aliases it does not rename', () => {
    for (const zone of ['Europe/Amsterdam', 'Europe/Kyiv', 'UTC', 'CET', 'US/Eastern', 'Not/AZone']) {
      expect(modernTimeZone(zone)).toBe(zone);
    }
  });

  /**
   * A rename, not a tzdata link: IANA links some zones to another country's
   * (Asmera → Nairobi), and following one would move a teacher across a
   * border. `Intl` resolving both sides to one zone is what a rename is.
   */
  it('pairs each old spelling with a name Intl treats as the same zone', () => {
    for (const [old, current] of MODERN_ZONE_NAMES) {
      expect(isValidTimeZone(current), current).toBe(true);
      expect(resolve(current), `${old} → ${current}`).toBe(resolve(old));
    }
  });

  it('never maps to a name it would rename again', () => {
    for (const current of MODERN_ZONE_NAMES.values()) {
      expect(MODERN_ZONE_NAMES.has(current), current).toBe(false);
    }
  });
});

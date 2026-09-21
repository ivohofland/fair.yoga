import { describe, it, expect } from 'vitest';
import { slotDate, slotTime } from '../../tests/class-fixtures';

describe('slotTime', () => {
  describe('valid standard offsets', () => {
    it('formats 0 minutes as 09:00', () => {
      expect(slotTime(0)).toBe('09:00');
    });

    it('formats 30 minutes as 09:30', () => {
      expect(slotTime(30)).toBe('09:30');
    });

    it('formats 75 minutes across hour boundary as 10:15', () => {
      expect(slotTime(75)).toBe('10:15');
    });

    it('formats 540 minutes as 18:00', () => {
      expect(slotTime(540)).toBe('18:00');
    });

    it('formats 900 minutes as 24:00 (Postgres time upper bound)', () => {
      expect(slotTime(900)).toBe('24:00');
    });
  });

  describe('valid negative whole-hour offsets', () => {
    it('formats -540 minutes as 00:00', () => {
      expect(slotTime(-540)).toBe('00:00');
    });

    it('formats -60 minutes as 08:00', () => {
      expect(slotTime(-60)).toBe('08:00');
    });
  });

  describe('ceiling enforcement (Postgres 24:00:00 limit)', () => {
    it('throws when offset is 901 (24:01)', () => {
      expect(() => slotTime(901)).toThrow(
        "slotTime(901) would produce '24:01', past '24:00:00' — the last time-of-day value Postgres's `time` accepts. The caller has run its counter out of slots in this block.",
      );
    });

    it('throws when offset is 960 (25:00)', () => {
      expect(() => slotTime(960)).toThrow(
        "slotTime(960) would produce '25:00', past '24:00:00' — the last time-of-day value Postgres's `time` accepts. The caller has run its counter out of slots in this block.",
      );
    });
  });

  describe('format validation', () => {
    it('throws when producing invalid minutes (e.g. negative non-multiples of 60)', () => {
      expect(() => slotTime(-30)).toThrow('slotTime produced an invalid startTime: 08:-30');
    });
  });
});

describe('slotDate', () => {
  it('offsets days by counter increments from a base Date', () => {
    const base = new Date('2026-06-01T00:00:00.000Z');
    expect(slotDate(base, 0)).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(slotDate(base, 1)).toEqual(new Date('2026-06-02T00:00:00.000Z'));
    expect(slotDate(base, 7)).toEqual(new Date('2026-06-08T00:00:00.000Z'));
  });

  it('accepts string date as base', () => {
    expect(slotDate('2026-06-01', 0)).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(slotDate('2026-06-01', 3)).toEqual(new Date('2026-06-04T00:00:00.000Z'));
  });

  it('normalizes time to UTC midnight 00:00:00.000Z', () => {
    const base = new Date('2026-06-01T15:45:30.123Z');
    const result = slotDate(base, 2);
    expect(result.toISOString()).toBe('2026-06-03T00:00:00.000Z');
  });

  it('handles month boundary rollover', () => {
    const base = new Date('2026-06-30T00:00:00.000Z');
    expect(slotDate(base, 1)).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });

  it('handles year boundary rollover', () => {
    const base = new Date('2026-12-31T00:00:00.000Z');
    expect(slotDate(base, 1)).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('does not mutate the input Date instance', () => {
    const base = new Date('2026-06-01T12:30:00.000Z');
    const snapshot = base.getTime();
    slotDate(base, 5);
    expect(base.getTime()).toBe(snapshot);
  });
});

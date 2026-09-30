import { describe, it, expect } from 'vitest';
import { parseBirthday, dayMonthOf, ageOn } from './birthday';

const NOW = new Date('2026-09-30T12:00:00.000Z');

describe('parseBirthday', () => {
  it('builds UTC midnight from a date-only string', () => {
    const r = parseBirthday('1990-01-01', NOW);
    expect(r).toEqual({ ok: true, date: new Date('1990-01-01T00:00:00.000Z') });
  });

  it.each(['1990-1-1', '1990-01-01T00:00:00.000Z', '1990-01-01T00:00:00+02:00', 'not-a-date', ''])(
    'refuses %j as format',
    (s) => {
      expect(parseBirthday(s, NOW)).toEqual({ ok: false, reason: 'format' });
    },
  );

  it.each(['2023-02-30', '1990-13-01', '1990-00-10', '2023-02-29'])('refuses the non-date %j as format', (s) => {
    expect(parseBirthday(s, NOW)).toEqual({ ok: false, reason: 'format' });
  });

  it('accepts 29 February in a leap year', () => {
    expect(parseBirthday('2000-02-29', NOW).ok).toBe(true);
  });

  it('accepts today and the lower bound, refuses tomorrow and before 1900', () => {
    expect(parseBirthday('2026-09-30', NOW).ok).toBe(true);
    expect(parseBirthday('1900-01-01', NOW).ok).toBe(true);
    expect(parseBirthday('2026-10-01', NOW)).toEqual({ ok: false, reason: 'range' });
    expect(parseBirthday('1899-12-31', NOW)).toEqual({ ok: false, reason: 'range' });
  });

  // A date input accepts a five-digit year, and Date.UTC maps years 0–99 onto
  // 1900–1999; both are real dates outside the range, not malformed ones.
  it.each(['20260-01-01', '0050-06-01', '0000-01-01'])('refuses the out-of-range year %j as range', (s) => {
    expect(parseBirthday(s, NOW)).toEqual({ ok: false, reason: 'range' });
  });

  // 02:00Z on 1 October is still 30 September west of UTC; the bound is the
  // UTC date, so 1 October is today, not tomorrow.
  it('bounds today by the UTC calendar date, not the local one', () => {
    expect(parseBirthday('2026-10-01', new Date('2026-10-01T02:00:00.000Z')).ok).toBe(true);
  });
});

describe('dayMonthOf', () => {
  it('reads with UTC accessors, month 1-based', () => {
    expect(dayMonthOf(new Date('1992-06-15T00:00:00.000Z'))).toEqual({ day: 15, month: 6 });
  });
});

describe('ageOn', () => {
  const b = new Date('1990-04-17T00:00:00.000Z');
  it('is one less in a month before the birthday month', () => {
    expect(ageOn(b, new Date('2026-01-10T12:00:00.000Z'))).toBe(35);
  });
  it('is one less the day before the birthday', () => {
    expect(ageOn(b, new Date('2026-04-16T23:59:00.000Z'))).toBe(35);
  });
  it('turns over on the birthday itself', () => {
    expect(ageOn(b, new Date('2026-04-17T00:00:00.000Z'))).toBe(36);
  });
  it('turns a 29 February birthday over on 1 March in a non-leap year', () => {
    const leap = new Date('2000-02-29T00:00:00.000Z');
    expect(ageOn(leap, new Date('2026-02-28T12:00:00.000Z'))).toBe(25);
    expect(ageOn(leap, new Date('2026-03-01T00:00:00.000Z'))).toBe(26);
  });
});

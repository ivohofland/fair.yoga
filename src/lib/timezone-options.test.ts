import { describe, it, expect } from 'vitest';
import { timeZoneOptions, type TimeZoneOptions } from './timezone-options';

const JANUARY = new Date('2026-01-15T12:00:00Z');
const JULY = new Date('2026-07-15T12:00:00Z');

const groupedValues = (o: TimeZoneOptions): string[] =>
  o.groups.flatMap((g) => g.options.map((opt) => opt.value));
const labelOf = (o: TimeZoneOptions, value: string): string | undefined =>
  [...o.standalone, ...o.groups.flatMap((g) => g.options)].find((opt) => opt.value === value)?.label;

describe('timeZoneOptions', () => {
  it('offers the zones the 26-item list could not', () => {
    const values = groupedValues(timeZoneOptions('Europe/Amsterdam', JANUARY));
    for (const zone of [
      'Pacific/Auckland', 'Asia/Tokyo', 'America/Sao_Paulo', 'Africa/Lagos', 'Asia/Kolkata', 'Asia/Dubai',
    ]) {
      expect(values, zone).toContain(zone);
    }
  });

  it('lists current IANA names, never the old spellings', () => {
    const values = groupedValues(timeZoneOptions('Europe/Amsterdam', JANUARY));
    expect(values).toContain('Europe/Kyiv');
    expect(values).not.toContain('Europe/Kiev');
    expect(values).not.toContain('Asia/Calcutta');
  });

  it('lists no zone twice', () => {
    const values = groupedValues(timeZoneOptions('Europe/Amsterdam', JANUARY));
    expect(new Set(values).size).toBe(values.length);
  });

  it('groups by region, regions and cities sorted', () => {
    const { groups } = timeZoneOptions('Europe/Amsterdam', JANUARY);
    const regions = groups.map((g) => g.region);
    expect(regions).toEqual([...regions].sort((a, b) => a.localeCompare(b, 'en')));
    for (const g of groups) {
      const labels = g.options.map((o) => o.label);
      expect(labels, g.region).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')));
      for (const o of g.options) expect(o.value.startsWith(`${g.region}/`), o.value).toBe(true);
    }
  });

  it('labels a zone with its city and its offset at `now`', () => {
    const jan = timeZoneOptions('Europe/Amsterdam', JANUARY);
    const jul = timeZoneOptions('Europe/Amsterdam', JULY);
    expect(labelOf(jan, 'Pacific/Auckland')).toBe('Auckland (GMT+13)');
    expect(labelOf(jul, 'Pacific/Auckland')).toBe('Auckland (GMT+12)');
    expect(labelOf(jan, 'Europe/Amsterdam')).toBe('Amsterdam (GMT+1)');
    expect(labelOf(jul, 'Europe/Amsterdam')).toBe('Amsterdam (GMT+2)');
    expect(labelOf(jan, 'Asia/Kolkata')).toBe('Kolkata (GMT+5:30)');
    expect(labelOf(jan, 'America/Argentina/Buenos_Aires')).toBe('Argentina / Buenos Aires (GMT-3)');
  });

  it('adds no standalone option when the stored zone is listed', () => {
    expect(timeZoneOptions('Europe/Amsterdam', JANUARY).standalone).toEqual([]);
    expect(timeZoneOptions('Asia/Kolkata', JANUARY).standalone).toEqual([]);
  });

  it('offers a stored zone the list lacks, so the picker is never blank', () => {
    for (const stored of ['UTC', 'CET']) {
      const options = timeZoneOptions(stored, JANUARY);
      expect(options.standalone.map((o) => o.value), stored).toEqual([stored]);
      expect(groupedValues(options), stored).not.toContain(stored);
    }
  });

  it('still renders a stored zone Intl cannot resolve, labelled with its identifier', () => {
    expect(timeZoneOptions('Invalid/Test_Zone_145', JANUARY).standalone).toEqual([
      { value: 'Invalid/Test_Zone_145', label: 'Invalid/Test_Zone_145' },
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import * as bounds from './input-bounds';
import { singleLineText, multiLineText, linkFreeText, COMMON_GENERIC_TLDS } from './input-bounds';

/**
 * The values the design decided (spec §2.1). The schema cap tests measure
 * each field against its constant, so they cannot see the constant itself
 * move; this pin does.
 */
describe('limit values', () => {
  it('are the decided ones', () => {
    const numeric = Object.fromEntries(
      Object.entries(bounds).filter(([, v]) => typeof v === 'number'),
    );
    expect(numeric).toEqual({
      NAME_MAX: 60,
      CLASS_TYPE_MAX: 80,
      LOCATION_MAX: 200,
      VENUE_NAME_MAX: 120,
      ROOM_NAME_MAX: 80,
      ROOM_ADDRESS_MAX: 200,
      CITY_MAX: 100,
      POSTCODE_MAX: 16,
      FLOOR_MAX: 40,
      EQUIPMENT_ITEM_MAX: 60,
      EQUIPMENT_ITEMS_MAX: 30,
      LONG_TEXT_MAX: 2000,
      PAYMENT_METHOD_MAX: 64,
      EMAIL_MAX: 254,
      PAGE_SLUG_MAX: 60,
      DURATION_MAX_MINUTES: 1440,
      MONEY_MAX: 100000,
      CAPACITY_MAX: 1000,
    });
  });
});

const single = singleLineText(60);
const multi = multiLineText(2000);
const linkFree = linkFreeText(60);

/** Each refused character embedded mid-word, so trimming cannot remove it. */
const REFUSED_EMBEDDED = {
  'NUL (U+0000)': 'An\u0000na',
  'right-to-left override (U+202E)': 'An‮na',
  'zero-width space (U+200B)': 'evil​.com',
  'word joiner (U+2060)': 'An⁠na',
  'byte-order mark (U+FEFF)': 'An﻿na',
  'line separator (U+2028)': 'An na',
  'paragraph separator (U+2029)': 'An na',
  'left-to-right mark (U+200E)': 'An‎na',
  'Arabic letter mark (U+061C)': 'An؜na',
  'first-strong isolate (U+2068)': 'An⁨na',
  'DEL (U+007F)': 'An\u007Fna',
} as const;

/** The same characters alone or at an edge, where a trim would otherwise swallow them. */
const REFUSED_AT_EDGE = ['﻿', 'Anna ', '​Anna', 'Anna\u0000'] as const;

describe('control and format characters', () => {
  it.each(Object.entries(REFUSED_EMBEDDED))('single-line refuses %s', (_label, value) => {
    expect(single.safeParse(value).success).toBe(false);
  });

  it.each(Object.entries(REFUSED_EMBEDDED))('multi-line refuses %s', (_label, value) => {
    expect(multi.safeParse(value).success).toBe(false);
  });

  it.each(REFUSED_AT_EDGE)('single-line refuses %j before trimming could hide it', (value) => {
    expect(single.safeParse(value).success).toBe(false);
  });

  it('single-line refuses a newline, a carriage return and a tab mid-text', () => {
    expect(single.safeParse('Anna\nSmith').success).toBe(false);
    expect(single.safeParse('Anna\rSmith').success).toBe(false);
    expect(single.safeParse('Anna\tSmith').success).toBe(false);
  });

  it('multi-line accepts a newline, a carriage return and a tab', () => {
    expect(multi.safeParse('Line one\r\nLine two\n\tindented').success).toBe(true);
  });

  it('accepts a Devanagari name joined with ZWJ and a Persian name with ZWNJ', () => {
    // क्‍ष: KA + VIRAMA + ZWJ + SSA; می‌خواهم: the ZWNJ between می and خواهم.
    const devanagari = 'क्‍ष्मा';
    const persian = 'می‌خواهم';
    for (const schema of [single, multi, linkFree]) {
      expect(schema.safeParse(devanagari).success).toBe(true);
      expect(schema.safeParse(persian).success).toBe(true);
    }
  });

  it('accepts an emoji ZWJ sequence', () => {
    expect(single.safeParse('Yoga \u{1F9D8}‍♀️').success).toBe(true);
  });
});

describe('trimming', () => {
  it('single-line trims and measures the trimmed value', () => {
    expect(single.parse('  Anna  ')).toBe('Anna');
    expect(single.safeParse(` ${'a'.repeat(60)} `).success).toBe(true);
  });

  it('multi-line keeps leading and trailing whitespace', () => {
    expect(multi.parse('  hello\n')).toBe('  hello\n');
  });
});

describe('length caps', () => {
  it('single-line accepts the limit and refuses one past it', () => {
    expect(single.safeParse('a'.repeat(60)).success).toBe(true);
    expect(single.safeParse('a'.repeat(61)).success).toBe(false);
  });

  it('multi-line accepts the limit and refuses one past it', () => {
    expect(multi.safeParse('a'.repeat(2000)).success).toBe(true);
    expect(multi.safeParse('a'.repeat(2001)).success).toBe(false);
  });

  it('link-free accepts the limit and refuses one past it', () => {
    expect(linkFree.safeParse('a'.repeat(60)).success).toBe(true);
    expect(linkFree.safeParse('a'.repeat(61)).success).toBe(false);
  });
});

describe('link refusal', () => {
  const REFUSED = [
    'evil.com',
    'EVIL.COM',
    'bank.nl',
    'verify.de',
    'https://x',
    'www.x',
    'WWW.x',
    'a@b',
    'evil。com',
    'evil．com',
    'evil｡com',
    'evil․com',
    'Visit evil.com now',
    'Anna (bank.nl)',
    'my-bank.info',
    'shop2.io',
  ];

  const ACCEPTED = [
    'St.Clair',
    'J.R. Smith',
    'J.de Groot',
    'Th.van Dijk',
    'Ma.del Carmen',
    "Anne-Marie O'Neil",
    "d'Artagnan",
    'St. Clair',
    'محمد عبد الله',
    '山田 太郎',
    '王小明',
    'Zoë Ångström-Ødegaard',
    'Vinyasa Flow 2.0',
  ];

  it.each(REFUSED)('refuses %j', (value) => {
    expect(linkFree.safeParse(value).success).toBe(false);
  });

  it.each(ACCEPTED)('accepts %j', (value) => {
    expect(linkFree.safeParse(value).success).toBe(true);
  });

  it.each(ACCEPTED)('single-line also accepts %j', (value) => {
    expect(single.safeParse(value).success).toBe(true);
  });

  it('single-line does not refuse link-shaped text', () => {
    expect(single.safeParse('evil.com').success).toBe(true);
  });

  it.each(COMMON_GENERIC_TLDS)('refuses a host ending in the listed TLD %s', (tld) => {
    expect(linkFree.safeParse(`evil.${tld}`).success).toBe(false);
    expect(linkFree.safeParse(`evil.${tld.toUpperCase()}`).success).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { normalSpread, previewClass } from './pricing-preview';
import { PRICING_EXAMPLES, examplePreview, parseExampleKey } from './pricing-examples';

describe('parseExampleKey', () => {
  it.each([
    [undefined, 'typical'],
    ['popular', 'popular'],
    [['vat', 'popular'], 'vat'],
    ['', 'typical'],
    ['Popular', 'typical'],
    ['nope', 'typical'],
  ])('parseExampleKey(%j) is %s', (raw, key) => {
    expect(parseExampleKey(raw)).toBe(key);
  });
});

describe('PRICING_EXAMPLES', () => {
  it('every example keeps its minimum at or above minus the room cost', () => {
    for (const e of Object.values(PRICING_EXAMPLES)) {
      expect(e.minRate).toBeGreaterThanOrEqual(-e.roomCost);
    }
  });

  it('the typical example is the one the homepage proof shows', () => {
    expect(examplePreview('typical')).toEqual(
      previewClass(
        { roomCost: 30, minRate: 40, targetRate: 90, minStudents: 4, maxStudents: 12, vatPercent: 0 },
        normalSpread(7),
      ),
    );
  });
});

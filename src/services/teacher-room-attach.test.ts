import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { compareExistingLink } from './teacher-room-attach';

const stored = {
  isArchived: false,
  capacityOverride: 6,
  rentalRate: new Prisma.Decimal('12.34'),
  equipmentNotes: null,
};

describe('compareExistingLink', () => {
  it('answers unchanged for exactly the values the link holds', () => {
    expect(
      compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.34, equipmentNotes: null }),
    ).toBe('unchanged');
  });

  // The column keeps two decimals, so a request carrying more is compared as
  // it would have been stored. The cases sit either side of a tie, never on
  // one, so they hold whichever way a tie would round.
  it('compares the rate as the column stores it, to two decimals', () => {
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.344 })).toBe('unchanged');
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.336 })).toBe('unchanged');
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.346 })).toBe('differs');
  });

  it('reads an absent note as null, and an empty note as a value', () => {
    expect(compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.34 })).toBe('unchanged');
    expect(
      compareExistingLink(stored, { capacityOverride: 6, rentalRate: 12.34, equipmentNotes: '' }),
    ).toBe('differs');
  });

  it.each([
    ['rate', { rentalRate: 12.35 }],
    ['capacity', { capacityOverride: 7 }],
    ['notes', { equipmentNotes: 'Mats provided' }],
  ] as const)('answers differs when the %s differs', (_field, change) => {
    expect(
      compareExistingLink(stored, {
        capacityOverride: 6,
        rentalRate: 12.34,
        equipmentNotes: null,
        ...change,
      }),
    ).toBe('differs');
  });

  it('answers archived for an archived link, even when every value matches', () => {
    expect(
      compareExistingLink({ ...stored, isArchived: true }, { capacityOverride: 6, rentalRate: 12.34 }),
    ).toBe('archived');
  });
});

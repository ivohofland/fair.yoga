import { describe, it, expect } from 'vitest';
import { GIVE_PAGE_BACK, GIVE_PAGE_HEADING, giveCaption } from './give-page-copy';

describe('give page copy', () => {
  it('words the heading and back link', () => {
    expect(GIVE_PAGE_HEADING).toBe('Thank you for coming.');
    expect(GIVE_PAGE_BACK).toBe('Your bookings');
  });

  it('builds the caption from class, day and teacher', () => {
    expect(
      giveCaption(
        { classType: 'Slow flow', date: new Date('2026-11-03T00:00:00Z') },
        { firstName: 'Anna', lastName: 'Smith' },
      ),
    ).toBe('Slow flow · Tuesday, 3 Nov · with Anna Smith');
  });
});

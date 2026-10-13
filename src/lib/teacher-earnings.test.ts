import { describe, expect, it } from 'vitest';
import { teacherEarningsCents } from './teacher-earnings';

describe('teacherEarningsCents', () => {
  it('is what students paid less the room', () => {
    expect(teacherEarningsCents({ totalCents: 11000, roomCents: 3000, vatCents: 0 })).toBe(8000);
  });

  it('is negative when the room cost more than students paid', () => {
    expect(teacherEarningsCents({ totalCents: 0, roomCents: 3000, vatCents: 0 })).toBe(-3000);
  });

  it('takes the VAT out as well as the room', () => {
    expect(teacherEarningsCents({ totalCents: 11990, roomCents: 3000, vatCents: 990 })).toBe(8000);
  });
});
